require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { loadBls, saveBls, queryApi } = require('./roller');

const SEND_XML_DIR   = process.env.SEND_XML_DIR || '';
const RECV_XML_DIR   = process.env.RECV_XML_DIR || '';
const CHECK_INTERVAL = 60 * 1000; // 1분

const processedFiles = new Set();

function getXmlDirs() {
  const dirs = [];
  if (SEND_XML_DIR) dirs.push({ dir: SEND_XML_DIR, label: 'SEND' });
  if (RECV_XML_DIR) dirs.push({ dir: RECV_XML_DIR, label: 'RECV' });
  return dirs;
}

function readFile(filePath) {
  for (const enc of ['utf8', 'cp949', 'latin1']) {
    try { return fs.readFileSync(filePath, enc); } catch { continue; }
  }
  return '';
}

function stripNs(xml) {
  return xml
    .replace(/\s+xmlns(?::[a-zA-Z0-9_]+)?="[^"]*"/g, '')
    .replace(/\s+xsi:schemaLocation="[^"]*"/g, '')
    .replace(/<(\/?)[a-zA-Z0-9_]+:([a-zA-Z0-9_])/g, '<$1$2');
}

function extractInfo(xml) {
  const clean = stripNs(xml);

  // 대행사 코드: GoodsShipment > Agent > ID
  const agentM = clean.match(/<GoodsShipment[^>]*>[\s\S]*?<Agent>\s*<ID>([^<]{1,20})<\/ID>/);
  const agencyCode = agentM ? agentM[1].trim() : null;

  // HBL: TransportContractDocument > TypeCode=714
  const hblM = clean.match(/<TransportContractDocument>\s*<ID>([^<]+)<\/ID>\s*<TypeCode>714<\/TypeCode>/s);
  const hblNo = hblM ? hblM[1].trim() : null;

  // 신고일자: IssueDateTime YYYYMMDD
  const dtM = clean.match(/<IssueDateTime>(\d{4})(\d{2})(\d{2})/);
  const blDate = dtM ? `${dtM[1]}-${dtM[2]}-${dtM[3]}` : null;
  const blYy   = dtM ? dtM[1] : String(new Date().getFullYear());

  return { agencyCode, hblNo, blYy, blDate };
}

async function processFile(filePath) {
  const content = readFile(filePath);
  if (!content) return;

  const { agencyCode, hblNo, blYy, blDate } = extractInfo(content);
  if (!agencyCode || !hblNo) return;

  const bls = loadBls();
  if (bls.find(b => b.hblNo === hblNo && b.blYy === blYy)) return;

  console.log(`[XML감시] 신규 HBL: ${hblNo} (${blDate || blYy}) 대행사: ${agencyCode}`);

  const result = await queryApi(hblNo, blYy);
  const now = new Date().toISOString();
  const newBl = {
    hblNo, blYy, agencyCode,
    blDate:        blDate || null,
    registeredAt:  now,
    currentStatus: result?.mtTrgtCargYnNm || '-',
    prgsStts:      result?.prgsStts        || '-',
    shipNm:        result?.shipNm          || '-',
    dsprNm:        result?.dsprNm          || '-',
    etprDt:        result?.etprDt          || '-',
    mblNo:         result?.mblNo           || '-',
    lastChecked:   now,
    scanStatus:    result ? 'ok' : 'error',
    hasChange:     false,
    progressHistory: [],
  };

  if (result?.mtTrgtCargYnNm && result.mtTrgtCargYnNm !== '-' && result.mtTrgtCargYnNm !== '비대상') {
    newBl.progressHistory.push({ status: result.mtTrgtCargYnNm, detectedAt: now });
  }

  bls.push(newBl);
  saveBls(bls);
  console.log(`[XML감시] 등록 완료: ${hblNo}`);
}

// 날짜 범위 + 대행사 코드로 send + recv 전체 스캔
async function scanForAgency(agencyCode, fromDate, toDate) {
  const dirs = getXmlDirs();
  if (dirs.length === 0) return { registered: 0, total: 0, error: 'not_configured' };

  let total = 0, registered = 0;

  for (const { dir, label } of dirs) {
    if (!fs.existsSync(dir)) {
      console.warn(`[XML스캔] 폴더 접근 불가 (${label}): ${dir}`);
      continue;
    }

    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.xml'))
        .map(f => path.join(dir, f));

      for (const file of files) {
        const content = readFile(file);
        if (!content) continue;

        const { agencyCode: fileAgency, hblNo, blYy, blDate } = extractInfo(content);
        if (!fileAgency || fileAgency !== agencyCode || !hblNo) continue;

        if (fromDate && blDate && blDate < fromDate) continue;
        if (toDate   && blDate && blDate > toDate)   continue;

        total++;

        const current = loadBls();
        if (current.find(b => b.hblNo === hblNo && b.blYy === blYy)) continue;

        const result = await queryApi(hblNo, blYy);
        const now = new Date().toISOString();
        const newBl = {
          hblNo, blYy, agencyCode,
          blDate:        blDate || null,
          registeredAt:  now,
          currentStatus: result?.mtTrgtCargYnNm || '-',
          prgsStts:      result?.prgsStts        || '-',
          shipNm:        result?.shipNm          || '-',
          dsprNm:        result?.dsprNm          || '-',
          etprDt:        result?.etprDt          || '-',
          mblNo:         result?.mblNo           || '-',
          lastChecked:   now,
          scanStatus:    result ? 'ok' : 'error',
          hasChange:     false,
          progressHistory: [],
        };

        if (result?.mtTrgtCargYnNm && result.mtTrgtCargYnNm !== '-' && result.mtTrgtCargYnNm !== '비대상') {
          newBl.progressHistory.push({ status: result.mtTrgtCargYnNm, detectedAt: now });
        }

        const fresh = loadBls();
        if (!fresh.find(b => b.hblNo === hblNo && b.blYy === blYy)) {
          fresh.push(newBl);
          saveBls(fresh);
          registered++;
          console.log(`[XML스캔] 등록 (${label}): ${hblNo} (${blDate})`);
        }
      }
    } catch (e) {
      console.error(`[XML스캔] 오류 (${label}): ${e.message}`);
    }
  }

  console.log(`[XML스캔] 완료 — 스캔: ${total}, 신규등록: ${registered}`);
  return { registered, total };
}

// send + recv 모두 감시
function scan() {
  const dirs = getXmlDirs();
  if (dirs.length === 0) return;

  for (const { dir, label } of dirs) {
    if (!fs.existsSync(dir)) {
      console.warn(`[XML감시] 폴더 접근 불가 (${label}): ${dir}`);
      continue;
    }
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.xml'))
        .map(f => path.join(dir, f));

      for (const file of files) {
        if (processedFiles.has(file)) continue;
        processedFiles.add(file);
        processFile(file).catch(e => console.error(`[XML감시] 처리 오류 (${path.basename(file)}): ${e.message}`));
      }
    } catch (e) {
      console.error(`[XML감시] 스캔 오류 (${label}): ${e.message}`);
    }
  }
}

function startWatcher() {
  const dirs = getXmlDirs();
  if (dirs.length === 0) {
    console.log('[XML감시] SEND_XML_DIR/RECV_XML_DIR 미설정 — 자동 HBL 등록 비활성화');
    return;
  }
  console.log(`[XML감시] 시작: ${dirs.map(d => `${d.label}(${d.dir})`).join(', ')} (1분 간격)`);
  scan();
  setInterval(scan, CHECK_INTERVAL);
}

module.exports = { startWatcher, scanForAgency };
