require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.CUSTOMS_API_KEY;
// 관세청 수출입화물 진행정보 조회 API (data.go.kr)
const CUSTOMS_API_URL = 'https://unipass.customs.go.kr:38010/ext/rest/cargCsclPrgsInfoQry/retrieveCargCsclPrgsInfo';

function loadAgencies() {
  const raw = fs.readFileSync(path.join(__dirname, 'agencies.json'), 'utf-8');
  return JSON.parse(raw).agencies;
}

// 대행사 코드 검증
app.post('/api/auth', (req, res) => {
  const { code } = req.body;
  const agencies = loadAgencies();
  const agency = agencies.find(a => a.code === code && a.active);
  if (agency) {
    res.json({ success: true, name: agency.name });
  } else {
    res.status(401).json({ success: false, message: '유효하지 않은 대행사 코드입니다.' });
  }
});

// B/L 목록으로 관리대상검사여부 조회
app.post('/api/check-bls', async (req, res) => {
  const { code, blNumbers } = req.body;

  // 대행사 검증
  const agencies = loadAgencies();
  const agency = agencies.find(a => a.code === code && a.active);
  if (!agency) {
    return res.status(401).json({ success: false, message: '인증 실패' });
  }

  if (!Array.isArray(blNumbers) || blNumbers.length === 0) {
    return res.status(400).json({ success: false, message: 'B/L 번호를 입력해주세요.' });
  }

  const results = [];

  for (const blNo of blNumbers) {
    const trimmed = blNo.trim();
    if (!trimmed) continue;

    try {
      const response = await axios.get(CUSTOMS_API_URL, {
        params: {
          crkyCn: API_KEY,
          mblNo: trimmed,
          pageIndex: 1
        },
        timeout: 10000
      });

      const data = response.data;
      // 응답 파싱 - 관세청 API는 XML 또는 JSON 반환
      const cargList = extractCargoInfo(data, trimmed);
      results.push(...cargList);
    } catch (err) {
      results.push({
        blNo: trimmed,
        error: err.response?.data?.message || err.message || 'API 호출 실패',
        inspectionTarget: null
      });
    }
  }

  res.json({ success: true, agency: agency.name, results });
});

function extractCargoInfo(data, blNo) {
  try {
    // data.go.kr 관세청 API JSON 응답 구조 파싱
    const items = data?.cargCsclPrgsInfoQryVo?.cargCsclPrgsInfoQryVoList;
    if (!items || items.length === 0) {
      return [{ blNo, inspectionTarget: null, status: '정보 없음', shipName: '-', portName: '-', arrivalDate: '-' }];
    }

    return items.map(item => ({
      blNo: item.mblNo || blNo,
      hblNo: item.hblNo || '-',
      shipName: item.vslNm || '-',
      portName: item.dsprCntrCd || '-',
      arrivalDate: item.etprDt || '-',
      cargoStatus: item.cargTpcd || '-',
      inspectionTarget: item.mgtrSbjTpcd === 'Y' ? '대상' : (item.mgtrSbjTpcd === 'N' ? '비대상' : (item.mgtrSbjTpcd || '확인불가')),
      inspectionRaw: item.mgtrSbjTpcd || '-',
      customsStatus: item.cargCsclPrgsSttCd || '-'
    }));
  } catch (e) {
    return [{ blNo, inspectionTarget: null, error: '응답 파싱 오류', status: '-' }];
  }
}

// 대행사 목록 조회 (관리용)
app.get('/api/agencies', (req, res) => {
  const agencies = loadAgencies();
  res.json({ agencies });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
