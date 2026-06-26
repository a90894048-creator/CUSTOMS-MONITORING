require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { rollAll, loadBls, saveBls, loadHistory, queryApi } = require('./roller');
const { startWatcher, scanForAgency } = require('./xml-watcher');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AGENCIES_FILE = path.join(__dirname, 'agencies.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, ''));
}

function loadAgencies() {
  return readJson(AGENCIES_FILE).agencies;
}

// 대행사 인증 (코드 + 비밀번호)
app.post('/api/auth', (req, res) => {
  const { code, password } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '유효하지 않은 대행사 코드입니다.' });
  if (agency.password && agency.password !== password) {
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }
  res.json({ success: true, name: agency.name });
});

// HBL 목록 조회 — 로그인한 대행사 코드에 해당하는 HBL만 반환
app.get('/api/bls', (req, res) => {
  const { code } = req.query;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });
  const bls = loadBls().filter(b => !b.agencyCode || b.agencyCode === code);
  res.json({ success: true, bls });
});

// HBL 등록 — 대행사 코드를 함께 저장
app.post('/api/bls', async (req, res) => {
  const { code, hblNo, blYy } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });

  const bls = loadBls();
  if (bls.find(b => b.hblNo === hblNo && b.blYy === blYy)) {
    return res.status(400).json({ success: false, message: '이미 등록된 HBL입니다.' });
  }

  const result = await queryApi(hblNo, blYy);
  const now = new Date().toISOString();
  const newBl = {
    hblNo,
    blYy,
    agencyCode: code,
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

  if (result?.mtTrgtCargYnNm && result.mtTrgtCargYnNm !== '-' && result.mtTrgtCargYnNm !== '비대상') {
    newBl.progressHistory.push({ status: result.mtTrgtCargYnNm, detectedAt: now });
  }

  bls.push(newBl);
  saveBls(bls);
  res.json({ success: true, bl: newBl });
});

// HBL 삭제 — 자기 대행사 HBL만 삭제 가능
app.delete('/api/bls/:hblNo', (req, res) => {
  const { code } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });

  const bls = loadBls().filter(b => !(b.hblNo === req.params.hblNo && (!b.agencyCode || b.agencyCode === code)));
  saveBls(bls);
  res.json({ success: true });
});

// 변화 이력 조회 — 로그인 대행사 코드 필터
app.get('/api/history', (req, res) => {
  const { code } = req.query;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });
  const history = loadHistory().filter(h => !h.agencyCode || h.agencyCode === code);
  res.json({ success: true, history });
});

// ── 관리자 API ───────────────────────────────────────────────
app.get('/api/admin/agencies', (req, res) => {
  res.json({ success: true, agencies: loadAgencies() });
});

app.post('/api/admin/agencies', (req, res) => {
  const { code, name, password = '' } = req.body;
  if (!code || !name) return res.status(400).json({ success: false, message: '코드와 이름을 입력하세요.' });
  const data = readJson(AGENCIES_FILE);
  if (data.agencies.find(a => a.code === code)) {
    return res.status(400).json({ success: false, message: '이미 존재하는 코드입니다.' });
  }
  data.agencies.push({ code, name, active: true, password });
  fs.writeFileSync(AGENCIES_FILE, JSON.stringify(data, null, 2));
  res.json({ success: true, agencies: data.agencies });
});

app.put('/api/admin/agencies/:code', (req, res) => {
  const { name, active, password } = req.body;
  const data = readJson(AGENCIES_FILE);
  const agency = data.agencies.find(a => a.code === req.params.code);
  if (!agency) return res.status(404).json({ success: false, message: '대행사를 찾을 수 없습니다.' });
  if (name !== undefined) agency.name = name;
  if (active !== undefined) agency.active = active;
  if (password !== undefined) agency.password = password;
  fs.writeFileSync(AGENCIES_FILE, JSON.stringify(data, null, 2));
  res.json({ success: true, agencies: data.agencies });
});

app.delete('/api/admin/agencies/:code', (req, res) => {
  const data = readJson(AGENCIES_FILE);
  data.agencies = data.agencies.filter(a => a.code !== req.params.code);
  fs.writeFileSync(AGENCIES_FILE, JSON.stringify(data, null, 2));
  res.json({ success: true, agencies: data.agencies });
});

// XML 폴더 스캔 → 대행사 HBL 일괄 등록 후 날짜 필터 결과 반환
app.post('/api/bls/scan', async (req, res) => {
  const { code, fromDate, toDate } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });

  const scanResult = await scanForAgency(code, fromDate || null, toDate || null);

  const bls = loadBls()
    .filter(b => b.agencyCode === code)
    .filter(b => {
      const d = b.blDate || (b.registeredAt || '').slice(0, 10);
      if (fromDate && d < fromDate) return false;
      if (toDate   && d > toDate)   return false;
      return true;
    });

  res.json({ success: true, bls, scanResult });
});

// 수동 즉시 롤링 — 해당 대행사 HBL만 반환
app.post('/api/roll-now', async (req, res) => {
  const { code } = req.body;
  const agency = loadAgencies().find(a => a.code === code && a.active);
  if (!agency) return res.status(401).json({ success: false, message: '인증 실패' });
  await rollAll();
  const bls = loadBls().filter(b => !b.agencyCode || b.agencyCode === code);
  res.json({ success: true, bls });
});

// 10분마다 자동 롤링
cron.schedule('*/10 * * * *', () => { rollAll(); });

// send_xml 폴더 감시 → 신규 HBL 자동 등록
startWatcher();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log('롤링 스케줄: 10분 간격 자동 실행');
});
