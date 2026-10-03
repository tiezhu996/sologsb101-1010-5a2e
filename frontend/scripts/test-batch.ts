/**
 * 批次对账引擎端到端逻辑验证（node + fake-indexeddb + tsx，不纳入构建）。
 * 运行：npx tsx scripts/test-batch.ts
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert'
import { db, resetDatabase, initDatabase } from '../src/lib/utils/db.ts'
import {
  startBatchImport,
  retryBatch,
  readingsOfBatch,
  processBatch,
  resolveReadingAssign,
  removeBatch
} from '../src/lib/stores/batchStore.ts'
import { parseBatchRows } from '../src/lib/types/batch.ts'
import type { BatchInputRow } from '../src/lib/types/batch.ts'
import { suggestLimitOhm } from '../src/lib/utils/resistance.ts'

let passed = 0
function check(name: string, cond: boolean): void {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✔ ${name}`)
}

async function setupClean(): Promise<void> {
  await db.delete()
  await db.open()
}

async function importBatch(batchNo: string, rows: BatchInputRow[], buildingId: string | null = null) {
  return startBatchImport(rows, {
    batchNo,
    sourceName: `${batchNo}.csv`,
    meter: 'ZC-8 / TEST',
    measureDate: '2026-10-03',
    buildingId
  })
}

// 演示数据：初始库有 3 栋建筑 / 6 装置 / 10 测点（含 1 条并列）/ 1 条待处理读数
await initDatabase()
const seedPoints = await db.points.toArray()
const seedReadings = await db.readings.toArray()
const seedBatches = await db.batches.toArray()
check('演示数据：测点全部回填批次号', seedPoints.every((p) => typeof p.batchNo === 'string' && p.batchNo.length > 0))
check('演示数据：播种了 1 个外场批次 + 读数留痕', seedBatches.length === 1 && seedReadings.length === seedPoints.length + 1)
const seedPending = seedReadings.filter((r) => r.status === 'pending')
check('演示数据：包含 1 条待人工指派样本', seedPending.length === 1)
const parallel = seedPoints.filter((p) => p.readingOrdinal > 1)
check('演示数据：同测点并列读数保留（JD-OIL-04 #2，7.9Ω）', parallel.length === 1 && parallel[0].measuredOhm === 7.9)

/* ---------- 场景 1：批次号幂等，重复导入不重复建档 ---------- */
await setupClean()
await resetDatabase()
const oilBelt = await db.devices.where('type').equals('接闪带').toArray()
const oilBuildingId = oilBelt.find((d) => d.id === 'dev_oil_belt')?.buildingId ?? null
const rowsA = parseBatchRows('JD-OIL-01,接闪带,3.5,10,屋面西北角').rows
const first = await importBatch('PC-T1', rowsA, oilBuildingId)
check('场景1：新批次建档', first.reused === false && first.inserted === 1)
// 完全相同的行再导入
const again = await importBatch('PC-T1', rowsA, oilBuildingId)
check('场景1：同批次重复导入不建档、整行重复跳过', again.reused === true && again.inserted === 0 && again.duplicated === 1)
const batchRow = await db.batches.where('batchNo').equals('PC-T1').toArray()
check('场景1：批次档案仍只有 1 个', batchRow.length === 1)
const t1Points = (await db.points.where('deviceId').equals('dev_oil_belt').toArray()).filter((p) => p.code === 'JD-OIL-01')
check(
  '场景1：原测点判定已确认→新值并列保留（3.2 锁定 + 3.5 新建），重复导入未再增加',
  t1Points.length === 2 && t1Points.some((p) => p.measuredOhm === 3.2) && t1Points.some((p) => p.measuredOhm === 3.5)
)

/* ---------- 场景 2：同测点同批次多条读数并列保留；未确认时新值刷新主值 ---------- */
// 先把 JD-HOS-01 的已确认判定改为未确认，验证未确认测点的新实测会刷新主值、重判
const h1Verdict = await db.verdicts.where('pointId').equals('pnt_hosp_rod_1').first()
await db.verdicts.update(h1Verdict!.id, { confirmed: false })
const rowsB = parseBatchRows('JD-HOS-01,接闪杆,8.1,10,裙房屋面重测').rows
await importBatch('PC-T2', rowsB, 'bld_hosp02')
const h1 = (await db.points.where('deviceId').equals('dev_hosp_rod').toArray()).filter((p) => p.code === 'JD-HOS-01')
check('场景2：未确认测点的新实测刷新主值（7.4 → 8.1），未新建', h1.length === 1 && h1[0].measuredOhm === 8.1)
const h1VerdictAfter = await db.verdicts.where('pointId').equals('pnt_hosp_rod_1').first()
check('场景2：未确认判定随新实测重新初判且仍未确认', h1VerdictAfter?.confirmed === false && h1VerdictAfter?.result === '合格')
const rowsB2 = parseBatchRows('JD-HOS-01,接闪杆,6.2,10,裙房屋面再测').rows
await importBatch('PC-T2', rowsB2, 'bld_hosp02')
const h2 = (await db.points.where('deviceId').equals('dev_hosp_rod').toArray()).filter((p) => p.code === 'JD-HOS-01')
check('场景2：再导入不同值仍并列新建（8.1 与 6.2 共存），不自动取舍', h2.length === 2 && h2.some((p) => p.measuredOhm === 8.1) && h2.some((p) => p.measuredOhm === 6.2))
check('场景2：并列点序号正确（1 / 2）', h2.map((p) => p.readingOrdinal).sort().join(',') === '1,2')

/* ---------- 场景 3：已确认判定不被新实测值覆盖，改为并列 ---------- */
// JD-OIL-05（接地体，首值 3.9，判定已确认）导入新值 3.6
const rowsC = parseBatchRows('JD-OIL-05,接地体,3.6,4,罐区东侧测试井雨后复测').rows
await importBatch('PC-T3', rowsC, 'bld_oil01')
const g = (await db.points.where('deviceId').equals('dev_oil_grid').toArray()).filter((p) => p.code === 'JD-OIL-05')
check('场景3：已确认测点保留原值 3.9', g.some((p) => p.measuredOhm === 3.9))
check('场景3：新读数 3.6 并列新建，未覆盖', g.some((p) => p.measuredOhm === 3.6) && g.length === 2)
const originalVerdict = await db.verdicts.where('pointId').equals(g.find((p) => p.measuredOhm === 3.9)!.id).first()
check('场景3：原判定仍为已确认且限值快照=4', originalVerdict?.confirmed === true && originalVerdict?.result === '合格' && originalVerdict?.limitOhm === 4)
const newPoint = g.find((p) => p.measuredOhm === 3.6)!
const newVerdict = await db.verdicts.where('pointId').equals(newPoint.id).first()
check('场景3：并列新点初判合格但未确认', newVerdict?.confirmed === false && newVerdict?.result === '合格')
const cReadings = readingsOfBatch((await db.batches.where('batchNo').equals('PC-T3').first())!.id)
check('场景3：读数动作标记 protected-point', cReadings[0].action === 'protected-point')

/* ---------- 场景 4：找不到唯一装置 → 待人工指派 → 指派后挂接 ---------- */
// 编号全新，建筑范围内有 2 个同类型装置（油库有 2 个… 引下线只有1个；用全新编号+接闪带？油库只有1个接闪带。用全部建筑范围 + 2个接闪带）
const rowsD = parseBatchRows('JD-NEW-99,接闪带,5.0,10,某屋面').rows
const d = await importBatch('PC-T4', rowsD, null)
check('场景4：两个接闪带装置且新编号 → pending', d.process.pending === 1 && d.process.attached === 0)
const dBatch = await db.batches.where('batchNo').equals('PC-T4').first()
const dReading = (await db.readings.where('batchId').equals(dBatch!.id).toArray())[0]
check('场景4：读数状态 pending', dReading.status === 'pending' && dReading.pointId === null)
// 指派到油库接闪带 → 新建
await resolveReadingAssign(dReading.id, 'dev_oil_belt')
const afterAssign = await db.readings.get(dReading.id)
check('场景4：人工指派后挂接并标记 manual-assign', afterAssign?.status === 'attached' && afterAssign.action === 'manual-assign' && afterAssign.deviceId === 'dev_oil_belt')
const assignedPoint = await db.points.get(afterAssign.pointId!)
check('场景4：在指派装置下新建测点 JD-NEW-99', assignedPoint?.deviceId === 'dev_oil_belt' && assignedPoint.code === 'JD-NEW-99')

/* ---------- 场景 5：写入失败保留断点，重试从断点继续 ---------- */
await setupClean()
await resetDatabase()
const rowsE = parseBatchRows(
  ['JD-OIL-01,接闪带,3.2,10,屋面西北角', 'JD-OIL-02,接闪带,4.1,10,屋面东南角', 'JD-FAIL-1,接地体,3.9,4,罐区东新点'].join('\n')
).rows

// 导入前注入一次性写入失败：第 3 行在唯一接地体下新建测点时抛错
const originalPut = db.points.put.bind(db.points)
let failedOnce = false
;(db.points as unknown as { put: typeof db.points.put }).put = async (...args: Parameters<typeof db.points.put>) => {
  const row = args[0] as { code?: string }
  if (!failedOnce && row.code === 'JD-FAIL-1') {
    failedOnce = true
    throw new Error('模拟写入失败（磁盘配额）')
  }
  return originalPut(...args)
}
const e = await importBatch('PC-T5', rowsE, 'bld_oil01')
;(db.points as unknown as { put: typeof db.points.put }).put = originalPut
check('场景5：处理到第 3 行写入失败即停（前 2 行已挂接）', e.process.attached === 2 && e.process.failed === 1 && e.process.stoppedAt === 2)
const eBatch = await db.batches.where('batchNo').equals('PC-T5').first()
check('场景5：检查点停在第 3 行（checkpoint=2）、批次 failed', eBatch!.checkpointIndex === 2 && eBatch!.status === 'failed')
const eReadings = (await db.readings.where('batchId').equals(eBatch!.id).toArray()).sort((a, b) => a.rowOrder - b.rowOrder)
const failedReading = eReadings[2]
check('场景5：失败行保留 failed 与原因，测点未建成', failedReading.status === 'failed' && failedReading.reason.includes('模拟写入失败'))
// 已成功处理的前两行不重复
const o1Count = (await db.points.where('deviceId').equals('dev_oil_belt').toArray()).filter((p) => p.code === 'JD-OIL-01').length
check('场景5：断点前的行未被重复处理（JD-OIL-01 仅 1 个）', o1Count === 1)
// 再重试（指定接地体装置）→ 成功
const retry2 = await retryBatch(eBatch!.id, 'dev_oil_grid')
check('场景5：重试后成功跑完', retry2.failed === 0 && retry2.attached >= 1)
const eBatchDone = await db.batches.get(eBatch!.id)
check('场景5：检查点恢复到 3、批次 completed', eBatchDone!.checkpointIndex === 3 && eBatchDone!.status === 'completed')
const recovered = (await db.points.where('deviceId').equals('dev_oil_grid').toArray()).find((p) => p.code === 'JD-FAIL-1')
check('场景5：断点行重试后测点建成', Boolean(recovered))

/* ---------- 场景 6：旧数据（无批次）迁移到初始批次，原有数据照旧 ---------- */
// 用只定义到 v2 的临时库构造旧数据，再由当前 db 打开触发 v3 升级
import Dexie from 'dexie'
await db.close()
await new Promise<void>((resolve) => indexedDB.deleteDatabase('gblightprot').onsuccess = () => resolve())

const legacyDb = new Dexie('gblightprot')
legacyDb.version(1).stores({
  buildings: 'id, name, usage, protectionClass',
  devices: 'id, buildingId, type, material',
  points: 'id, deviceId, code, measuredOhm',
  verdicts: 'id, pointId, result',
  rectifies: 'id, buildingId, state'
})
legacyDb.version(2).stores({
  buildings: 'id, name, usage, protectionClass, floors, heightM, updatedAt',
  devices: 'id, buildingId, type, material, spec, quantity, installDate, updatedAt',
  points: 'id, deviceId, code, measuredOhm, limitOhm, measureDate, updatedAt',
  verdicts: 'id, pointId, result, confirmed, verdictDate, updatedAt',
  rectifies: 'id, buildingId, pointId, state, deadline, updatedAt'
})
await legacyDb.open()
await legacyDb.transaction('rw', [legacyDb.table('buildings'), legacyDb.table('devices'), legacyDb.table('points'), legacyDb.table('verdicts')], async () => {
  await legacyDb.table('buildings').put({
    id: 'b1', name: '旧楼', usage: '住宅', protectionClass: '三类', floors: 3, heightM: 10,
    address: '旧街 1 号', createdAt: 1, updatedAt: 1
  })
  await legacyDb.table('devices').put({
    id: 'd1', buildingId: 'b1', type: '接地体', material: '镀锌钢管', spec: 'Φ50',
    quantity: 2, installDate: '2015-01-01', createdAt: 1, updatedAt: 1
  })
  await legacyDb.table('points').put({
    id: 'p1', deviceId: 'd1', code: 'JD-OLD-1', location: '旧测试点', measuredOhm: 2.5,
    limitOhm: 10, meter: '老仪器', measureDate: '2018-05-01', createdAt: 1, updatedAt: 1
  })
  await legacyDb.table('verdicts').put({
    id: 'v1', pointId: 'p1', result: '合格', basis: '老依据', inspector: '张工',
    verdictDate: '2018-05-01', confirmed: true, createdAt: 1, updatedAt: 1
  })
})
await legacyDb.close()

await db.open() // 触发 v3 upgrade
const oldPoint = await db.points.get('p1')
check('场景6：旧测点回填初始批次、序号 1', oldPoint?.batchNo === '初始批次' && oldPoint.readingOrdinal === 1)
check('场景6：旧测点实测/限值未变', oldPoint?.measuredOhm === 2.5 && oldPoint.limitOhm === 10)
const oldVerdict = await db.verdicts.get('v1')
check('场景6：旧判定仍是已确认合格，并补限值快照', oldVerdict?.confirmed === true && oldVerdict.result === '合格' && oldVerdict.limitOhm === 10)
const legacyBatch = await db.batches.get('bat_legacy')
check('场景6：生成初始批次档案', legacyBatch?.batchNo === '初始批次' && legacyBatch.totalRows === 1)
const legacyReadings = await db.readings.where('batchId').equals('bat_legacy').toArray()
check('场景6：旧测点有迁移读数留痕（migrated-legacy）', legacyReadings.length === 1 && legacyReadings[0].action === 'migrated-legacy' && legacyReadings[0].pointId === 'p1')

/* ---------- 场景 7：删除批次档案保留测点 ---------- */
await setupClean()
await resetDatabase()
const r = await importBatch('PC-T7', parseBatchRows('JD-NEW-7,接地体,1.1,4,新点').rows, 'bld_oil01')
const newPointCountBefore = await db.points.count()
await removeBatch(r.batchId, false)
check('场景7：删档案后批次与读数清空', (await db.batches.get(r.batchId)) === undefined && (await db.readings.where('batchId').equals(r.batchId).count()) === 0)
check('场景7：挂接生成的测点保留', (await db.points.count()) === newPointCountBefore)

console.log(`\n全部 ${passed} 项断言通过 ✅`)
