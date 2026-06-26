const https = require('https');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.CUSTOMS_API_KEY;
const CUSTOMS_API_URL = 'https://unipass.customs.go.kr:38010/ext/rest/cargCsclPrgsInfoQry/retrieveCargCsclPrgsInfo';

const BLS_FILE = path.join(__dirname, 'data', 'monitored-bls.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');

function loadBls() {
  return JSON.parse(fs.readFileSync(BLS_FILE, 'utf-8')).bls;
}

function saveBls(bls) {
  fs.writeFileSync(BLS_FILE, JSON.stringify({ bls }, null, 2));
}

function loadHistory() {
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')).history;
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ history }, null, 2));
}

function queryApi(hblNo, blYy) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({ crkyCn: API_KEY, hblNo, blYy });
    const url = `${CUSTOMS_API_URL}?${params}`;
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        try {
          const parsed = await xml2js.parseStringPromise(data, { explicitArray: false });
          const info = parsed?.cargCsclPrgsInfoQryRtnVo?.cargCsclPrgsInfoQryVo;
          if (!info) return resolve(null);
          const item = Array.isArray(info) ? info[0] : info;
          resolve({
            hblNo: item.hblNo || hblNo,
            mblNo: item.mblNo || '-',
            shipNm: item.shipNm || '-',
            dsprNm: item.dsprNm || '-',
            etprDt: item.etprDt || '-',
            prgsStts: item.prgsStts || '-',
            mtTrgtCargYnNm: item.mtTrgtCargYnNm || '-'
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function rollAll() {
  const bls = loadBls();
  const history = loadHistory();
  const now = new Date().toISOString();

  console.log(`[${new Date().toLocaleString('ko-KR')}] 롤링 시작 — ${bls.length}건`);

  for (const bl of bls) {
    const result = await queryApi(bl.hblNo, bl.blYy);
    if (!result) {
      bl.lastChecked = now;
      bl.scanStatus = 'error';
      continue;
    }

    const newStatus = result.mtTrgtCargYnNm;
    const prevStatus = bl.currentStatus;

    // 상태 변화 감지
    if (prevStatus && prevStatus !== newStatus) {
      history.unshift({
        id: Date.now(),
        hblNo: bl.hblNo,
        blYy: bl.blYy,
        from: prevStatus,
        to: newStatus,
        detectedAt: now,
        shipNm: result.shipNm,
        dsprNm: result.dsprNm
      });

      // 진행이력 순차 추가
      bl.progressHistory = bl.progressHistory || [];
      if (!bl.progressHistory.find(p => p.status === newStatus)) {
        bl.progressHistory.push({ status: newStatus, detectedAt: now });
      }

      bl.hasChange = true;
      console.log(`  [변화감지] ${bl.hblNo}: ${prevStatus} → ${newStatus}`);
    } else {
      bl.hasChange = false;
    }

    // 최초 등록 시 초기 이력 세팅
    if (!bl.currentStatus) {
      bl.progressHistory = [];
      if (newStatus && newStatus !== '-' && newStatus !== '비대상') {
        bl.progressHistory.push({ status: newStatus, detectedAt: now });
      }
    }

    bl.currentStatus = newStatus;
    bl.shipNm = result.shipNm;
    bl.dsprNm = result.dsprNm;
    bl.etprDt = result.etprDt;
    bl.prgsStts = result.prgsStts;
    bl.mblNo = result.mblNo;
    bl.lastChecked = now;
    bl.scanStatus = 'ok';
  }

  saveBls(bls);
  // 이력은 최대 500건 유지
  saveHistory(history.slice(0, 500));
  console.log(`[${new Date().toLocaleString('ko-KR')}] 롤링 완료`);
}

module.exports = { rollAll, loadBls, saveBls, loadHistory, queryApi };
