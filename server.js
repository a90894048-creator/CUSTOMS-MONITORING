require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.CUSTOMS_API_KEY;
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

  const agencies = loadAgencies();
  const agency = agencies.find(a => a.code === code && a.active);
  if (!agency) {
    return res.status(401).json({ success: false, message: '인증 실패' });
  }

  if (!Array.isArray(blNumbers) || blNumbers.length === 0) {
    return res.status(400).json({ success: false, message: 'B/L 번호를 입력해주세요.' });
  }

  const results = [];

  for (const entry of blNumbers) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // 입력 형식: "BL번호" 또는 "BL번호,년도" (예: HDMUSEL1234567,2024)
    const [blNo, blYy] = trimmed.split(',').map(s => s.trim());
    const year = blYy || String(new Date().getFullYear());

    try {
      const response = await axios.get(CUSTOMS_API_URL, {
        params: {
          crkyCn: API_KEY,
          mblNo: blNo,
          blYy: year
        },
        timeout: 15000,
        headers: { 'Accept': 'application/xml' }
      });

      const parsed = await xml2js.parseStringPromise(response.data, { explicitArray: false });
      const cargInfo = parsed?.cargCsclPrgsInfoQryRtnVo?.cargCsclPrgsInfoQryVo;

      if (!cargInfo) {
        results.push({ blNo, blYy: year, inspectionTarget: null, status: '정보 없음', shipNm: '-', dsprNm: '-', etprDt: '-', prgsStts: '-', csclPrgsStts: '-', hblNo: '-' });
        continue;
      }

      // 여러 건이면 배열, 한 건이면 객체
      const items = Array.isArray(cargInfo) ? cargInfo : [cargInfo];

      for (const item of items) {
        const mtTrgt = item.mtTrgtCargYnNm;
        results.push({
          blNo: item.mblNo || blNo,
          blYy: year,
          hblNo: item.hblNo || '-',
          shipNm: item.shipNm || '-',
          dsprNm: item.dsprNm || '-',
          etprDt: item.etprDt || '-',
          prgsStts: item.prgsStts || '-',
          csclPrgsStts: item.csclPrgsStts || '-',
          cargTp: item.cargTp || '-',
          inspectionTarget: mtTrgt === 'Y' ? '대상' : mtTrgt === 'N' ? '비대상' : (mtTrgt || '확인불가'),
          inspectionRaw: mtTrgt || '-'
        });
      }
    } catch (err) {
      const errMsg = err.response?.data
        ? await xml2js.parseStringPromise(err.response.data, { explicitArray: false })
            .then(p => p?.cargCsclPrgsInfoQryRtnVo?.ntceInfo?.ntceCn || 'API 오류')
            .catch(() => 'API 오류')
        : (err.message || 'API 호출 실패');

      results.push({
        blNo,
        blYy: year,
        error: errMsg,
        inspectionTarget: null
      });
    }
  }

  res.json({ success: true, agency: agency.name, results });
});

// 대행사 목록 조회
app.get('/api/agencies', (req, res) => {
  const agencies = loadAgencies();
  res.json({ agencies });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
