require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { rollAll, loadBls, saveBls, loadHistory, queryApi } = require('./roller');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AGENCIES_FILE = path.join(__dirname, 'agencies.json');

function loadAgencies() {
  return JSON.parse(fs.readFileSync(AGENCIES_FILE, 'utf-8')).agencies;
}

// 대행사 인증
app.post('/api/auth', (req, res) => {
  const { code } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (agency) {
    res.json({ success: true, name: agency.name });
  } else {
    res.status(401).json({ success: false, message: '유효하지 않은 대행사 코드입니다.' });
  }
});

// 전체 HBL 목록 + 현황 조회
app.get('/api/bls', (req, res) => {
  const { code } = req.query;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });
  res.json({ success: true, bls: loadBls() });
});

// HBL 등록
app.post('/api/bls', async (req, res) => {
  const { code, hblNo, blYy } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });

  const bls = loadBls();
  if (bls.find(b => b.hblNo === hblNo && b.blYy === blYy)) {
    return res.status(400).json({ success: false, message: '이미 등록된 HBL입니다.' });
  }

  // 등록 즉시 1회 조회
  const result = await queryApi(hblNo, blYy);
  const now = new Date().toISOString();
  const newBl = {
    hblNo,
    blYy,
    registeredAt: now,
    currentStatus: result?.mtTrgtCargYnNm || '-',
    prgsStts: result?.prgsStts || '-',
    shipNm: result?.shipNm || '-',
    dsprNm: result?.dsprNm || '-',
    etprDt: result?.etprDt || '-',
    mblNo: result?.mblNo || '-',
    lastChecked: now,
    scanStatus: result ? 'ok' : 'error',
    hasChange: false,
    progressHistory: []
  };

  // 최초 상태가 검사 관련이면 이력에 추가
  if (result?.mtTrgtCargYnNm && result.mtTrgtCargYnNm !== '-' && result.mtTrgtCargYnNm !== '비대상') {
    newBl.progressHistory.push({ status: result.mtTrgtCargYnNm, detectedAt: now });
  }

  bls.push(newBl);
  saveBls(bls);
  res.json({ success: true, bl: newBl });
});

// HBL 삭제
app.delete('/api/bls/:hblNo', (req, res) => {
  const { code } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });

  const bls = loadBls().filter(b => b.hblNo !== req.params.hblNo);
  saveBls(bls);
  res.json({ success: true });
});

// 변화 이력 조회
app.get('/api/history', (req, res) => {
  const { code } = req.query;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });
  res.json({ success: true, history: loadHistory() });
});

// 수동 즉시 롤링 트리거
app.post('/api/roll-now', async (req, res) => {
  const { code } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });
  await rollAll();
  res.json({ success: true, bls: loadBls() });
});

// 10분마다 자동 롤링 (*/10 * * * *)
cron.schedule('*/10 * * * *', () => {
  rollAll();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log('롤링 스케줄: 10분 간격 자동 실행');
});
