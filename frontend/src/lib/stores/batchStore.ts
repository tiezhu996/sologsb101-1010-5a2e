/**
 * 批次对账 store：外场接地电阻数据按批次导入、挂接、断点续传。
 *
 * 对账规则（每个导入行依次处理）：
 * 1. 同批次同编号同设备类型的测点已存在 → 并列保留（seq 递增，不自动取舍）；
 * 2. 历史原记录（同编号同设备类型）判定已确认 → 实测值不覆盖，并列建档；
 * 3. 历史原记录判定未确认 → 挂回原记录并更新实测值，未确认判定随新值重判；
 * 4. 无原记录 → 在批次目标建筑物下新建测点档案（装置缺失时自动登记）。
 *
 * 断点续传：每行处理结果与批次游标同事务提交；写入失败即中断，
 * 批次标记「部分失败」，重试时从「待处理 / 失败」行继续，不重复建档。
 *
 * 依赖方向（单向）：batchStore → utils/db、types/*，不 import 其他 store。
 */
import { derived, writable } from 'svelte/store'
import { createId, db, watchTable } from '$lib/utils/db'
import type { Device, DeviceType } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import { defaultBasis, judgePoint } from '$lib/types/verdict'
import type { BatchPasteRow, ImportBatch, ImportRow } from '$lib/types/batch'
import { rowFingerprint } from '$lib/types/batch'

/** 响应式批次集合与导入行集合 */
export const batchList = writable<ImportBatch[]>([])
export const importRowList = writable<ImportRow[]>([])
export const batchReady = writable(false)

watchTable<ImportBatch>(() => db.batches).subscribe((rows) => {
  batchList.set(rows)
  batchReady.set(true)
})
watchTable<ImportRow>(() => db.importRows).subscribe((rows) => {
  importRowList.set(rows)
})

/** 待处理项：待处理 + 失败的导入行（页面与导航徽标共用） */
export const pendingImportRows = derived(importRowList, ($rows) =>
  $rows.filter((row) => row.state === '待处理' || row.state === '失败')
)

export const pendingImportCount = derived(pendingImportRows, ($rows) => $rows.length)

/** 批次汇总行：批次 + 各状态行数，供对账页列表展示 */
export const batchSummaries = derived([batchList, importRowList], ([$batches, $rows]) =>
  [...$batches]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((batch) => {
      const rows = $rows.filter((row) => row.batchId === batch.id)
      const countOf = (state: ImportRow['state']): number => rows.filter((row) => row.state === state).length
      return {
        batch,
        rows,
        attached: countOf('已挂接'),
        created: countOf('已建档'),
        parallel: countOf('并列保留'),
        skipped: countOf('已跳过'),
        failed: countOf('失败'),
        pending: countOf('待处理')
      }
    })
)

/** 取某批次的导入行（按行号排序） */
export function rowsOfBatch(batchId: string, rows: ImportRow[]): ImportRow[] {
  return rows.filter((row) => row.batchId === batchId).sort((a, b) => a.rowIndex - b.rowIndex)
}

/* ------------------------------ 导入与处理引擎 ------------------------------ */

export interface ImportBatchInput {
  batchNo: string
  buildingId: string
  deviceType: DeviceType
  sourceNote: string
  meter: string
  measureDate: string
  rows: BatchPasteRow[]
}

export interface ImportBatchResult {
  batchId: string
  /** 是否复用了已有批次（相同批次号不重复建档） */
  reused: boolean
  /** 新追加的导入行数 */
  added: number
  /** 内容完全相同的重复行数（已跳过） */
  duplicated: number
  /** 本次处理完成后批次的待处理 / 失败行数 */
  pending: number
  failed: number
}

/**
 * 导入一批外场数据：按批次号幂等建档，追加新行后从断点开始处理。
 * 相同批次号重复导入时复用原批次，内容相同的行按指纹跳过，不会重复建档。
 */
export async function importBatchRows(input: ImportBatchInput): Promise<ImportBatchResult> {
  const now = Date.now()
  const batchNo = input.batchNo.trim()
  if (!batchNo) throw new Error('批次号不能为空')

  // 1. 按批次号找 / 建批次（相同批次号全站唯一）
  let batch = await db.batches.where('batchNo').equals(batchNo).first()
  let reused = true
  if (!batch) {
    reused = false
    batch = {
      id: createId('bat'),
      batchNo,
      buildingId: input.buildingId,
      deviceType: input.deviceType,
      sourceNote: input.sourceNote,
      state: '待处理',
      totalRows: 0,
      doneRows: 0,
      failedRows: 0,
      cursor: 1,
      createdAt: now,
      updatedAt: now
    }
    await db.batches.put(batch)
  }

  // 2. 追加新行：同批次内按内容指纹判重，重复导入同一份数据不会重复建档
  const existing = await db.importRows.where('batchId').equals(batch.id).toArray()
  const fingerprints = new Set(existing.map((row) => row.fingerprint))
  let maxIndex = existing.reduce((max, row) => Math.max(max, row.rowIndex), 0)
  let added = 0
  let duplicated = 0
  const newRows: ImportRow[] = []
  input.rows.forEach((row, index) => {
    const fingerprint = rowFingerprint(row)
    if (fingerprints.has(fingerprint)) {
      duplicated += 1
      return
    }
    fingerprints.add(fingerprint)
    maxIndex += 1
    added += 1
    newRows.push({
      id: createId('row'),
      batchId: batch.id,
      rowIndex: maxIndex,
      fingerprint,
      code: row.code,
      deviceType: row.deviceType,
      location: row.location,
      measuredOhm: row.measuredOhm,
      limitOhm: row.limitOhm,
      meter: input.meter,
      measureDate: input.measureDate,
      state: '待处理',
      pointId: null,
      message: '',
      createdAt: now + index,
      updatedAt: now + index
    })
  })
  if (newRows.length > 0) {
    await db.importRows.bulkPut(newRows)
    await db.batches.update(batch.id, { totalRows: existing.length + newRows.length, updatedAt: now })
  }

  // 3. 从断点处理待处理行
  const summary = await runBatch(batch.id)
  return { batchId: batch.id, reused, added, duplicated, pending: summary.pending, failed: summary.failed }
}

/**
 * 重试批次：从断点接着处理「待处理 / 失败」的导入行。
 * 已完成的行不会重跑，已建档的测点不会重复建档。
 */
export async function resumeBatch(batchId: string): Promise<{ pending: number; failed: number }> {
  return runBatch(batchId)
}

/** 删除批次：仅删除批次与导入行对账记录，已建档的测点档案保留 */
export async function removeBatch(batchId: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.importRows], async () => {
    await db.importRows.where('batchId').equals(batchId).delete()
    await db.batches.delete(batchId)
  })
}

/** 处理循环：逐行事务提交，写入失败即中断并保留断点 */
async function runBatch(batchId: string): Promise<{ pending: number; failed: number }> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在或已被删除')
  await db.batches.update(batchId, { state: '处理中', updatedAt: Date.now() })

  const pendingRows = (await db.importRows.where('batchId').equals(batchId).toArray())
    .filter((row) => row.state === '待处理' || row.state === '失败')
    .sort((a, b) => a.rowIndex - b.rowIndex)

  for (const row of pendingRows) {
    try {
      await processOneRow(batch, row)
    } catch (err) {
      // 写入失败：标记当前行并中断，断点游标保留在未完成位置，可重试续传
      const message = err instanceof Error ? err.message : '写入本地数据库失败'
      const now = Date.now()
      await db.importRows.update(row.id, { state: '失败', message, updatedAt: now }).catch(() => undefined)
      await refreshBatchState(batchId)
      return summarizeRows(await db.importRows.where('batchId').equals(batchId).toArray())
    }
  }
  await refreshBatchState(batchId)
  return summarizeRows(await db.importRows.where('batchId').equals(batchId).toArray())
}

/** 按导入行当前状态重算批次进度、游标与状态机 */
async function refreshBatchState(batchId: string): Promise<void> {
  const rows = await db.importRows.where('batchId').equals(batchId).toArray()
  const doneStates = new Set(['已挂接', '已建档', '并列保留', '已跳过'])
  const doneRows = rows.filter((row) => doneStates.has(row.state)).length
  const failedRows = rows.filter((row) => row.state === '失败').length
  const pendingRows = rows.filter((row) => row.state === '待处理' || row.state === '失败')
  const cursor = pendingRows.length > 0 ? Math.min(...pendingRows.map((row) => row.rowIndex)) : rows.length + 1
  const state =
    failedRows > 0 ? '部分失败' : rows.some((row) => row.state === '待处理') ? '处理中' : '已完成'
  await db.batches.update(batchId, {
    state,
    totalRows: rows.length,
    doneRows,
    failedRows,
    cursor,
    updatedAt: Date.now()
  })
}

function summarizeRows(rows: ImportRow[]): { pending: number; failed: number } {
  return {
    pending: rows.filter((row) => row.state === '待处理').length,
    failed: rows.filter((row) => row.state === '失败').length
  }
}

/**
 * 处理单个导入行（行结果 + 测点写入 + 批次游标在同一事务提交）。
 * 挂接键：批次号（当前批次）+ 测点编号 + 设备类型。
 */
async function processOneRow(batch: ImportBatch, row: ImportRow): Promise<void> {
  await db.transaction('rw', [db.points, db.verdicts, db.devices, db.buildings, db.importRows], async () => {
    const now = Date.now()
    const devices = await db.devices.toArray()
    const deviceById = new Map(devices.map((device) => [device.id, device]))
    const sameType = (point: Point): boolean => deviceById.get(point.deviceId)?.type === row.deviceType

    // 1. 同批次同编号同设备类型已建档 → 并列保留，不自动取舍
    const siblings = (await db.points.where('[batchId+code]').equals([batch.id, row.code]).toArray()).filter(sameType)
    if (siblings.length > 0) {
      const seq = Math.max(...siblings.map((point) => point.seq)) + 1
      const point = buildPointRow(batch, row, siblings[0].deviceId, seq, now)
      await db.points.put(point)
      await db.importRows.update(row.id, {
        state: '并列保留',
        pointId: point.id,
        message: `同批次同测点第 ${seq} 条记录，并列保留不取舍`,
        updatedAt: now
      })
      return
    }

    // 2. 历史原记录：同编号同设备类型（不限批次），取最近更新的一条
    const candidates = (await db.points.where('code').equals(row.code).toArray())
      .filter(sameType)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const target = candidates[0]
    if (target) {
      const verdict = await db.verdicts.where('pointId').equals(target.id).first()
      if (verdict?.confirmed) {
        // 已确认判定保护：实测值不覆盖原记录，新数据并列建档
        const point = buildPointRow(batch, row, target.deviceId, 1, now)
        await db.points.put(point)
        await db.importRows.update(row.id, {
          state: '并列保留',
          pointId: point.id,
          message: `原记录判定已确认（当时限值 ${verdict.limitOhm} Ω），实测值不覆盖，并列建档`,
          updatedAt: now
        })
        return
      }
      // 挂回原记录：更新实测值与批次来源；未确认判定随新实测值重新初判
      await db.points.update(target.id, {
        location: row.location || target.location,
        measuredOhm: row.measuredOhm,
        limitOhm: row.limitOhm,
        meter: row.meter || target.meter,
        measureDate: row.measureDate || target.measureDate,
        batchId: batch.id,
        batchNo: batch.batchNo,
        updatedAt: now
      })
      if (verdict) {
        await reJudgeUnconfirmed(verdict, target, row, now)
      }
      await db.importRows.update(row.id, {
        state: '已挂接',
        pointId: target.id,
        message: `挂回原记录 ${target.code}，实测值已更新为 ${row.measuredOhm} Ω`,
        updatedAt: now
      })
      return
    }

    // 3. 无原记录：在批次目标建筑物下新建测点档案（装置缺失时自动登记）
    const deviceId = await ensureDevice(batch, row.deviceType, devices, now)
    const point = buildPointRow(batch, row, deviceId, 1, now)
    await db.points.put(point)
    await db.importRows.update(row.id, {
      state: '已建档',
      pointId: point.id,
      message: '新建测点档案',
      updatedAt: now
    })
  })
}

/** 构造测点记录：来源批次 + 并列序号一并落库 */
function buildPointRow(
  batch: ImportBatch,
  row: ImportRow,
  deviceId: string,
  seq: number,
  now: number
): Point {
  return {
    id: createId('pnt'),
    deviceId,
    code: row.code,
    location: row.location,
    measuredOhm: row.measuredOhm,
    limitOhm: row.limitOhm,
    meter: row.meter,
    measureDate: row.measureDate,
    batchId: batch.id,
    batchNo: batch.batchNo,
    seq,
    createdAt: now,
    updatedAt: now
  }
}

/** 未确认判定随挂接的新实测值重新初判，限值快照同步更新（已确认的不动） */
async function reJudgeUnconfirmed(verdict: Verdict, target: Point, row: ImportRow, now: number): Promise<void> {
  const device = await db.devices.get(target.deviceId)
  const building = device ? await db.buildings.get(device.buildingId) : undefined
  await db.verdicts.update(verdict.id, {
    result: judgePoint(row.measuredOhm, row.limitOhm),
    basis: defaultBasis(building?.protectionClass ?? '三类', device?.type ?? '接地体', row.limitOhm),
    limitOhm: row.limitOhm,
    verdictDate: row.measureDate || target.measureDate,
    updatedAt: now
  } as never)
}

/** 找 / 建批次目标建筑物下指定类型的装置，返回装置 id */
async function ensureDevice(
  batch: ImportBatch,
  deviceType: DeviceType,
  devices: Device[],
  now: number
): Promise<string> {
  const matched = devices.find((device) => device.buildingId === batch.buildingId && device.type === deviceType)
  if (matched) return matched.id
  const id = createId('dev')
  const device: Device = {
    id,
    buildingId: batch.buildingId,
    type: deviceType,
    material: '待登记',
    spec: '',
    quantity: 1,
    installDate: new Date(now).toISOString().slice(0, 10),
    createdAt: now,
    updatedAt: now
  }
  await db.devices.put(device)
  devices.push(device)
  return id
}
