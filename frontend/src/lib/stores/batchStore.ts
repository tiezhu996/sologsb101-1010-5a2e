/**
 * 批次对账 store：外场批次数据导入、按「批次号 + 测点编号 + 设备类型」挂回档案、
 * 检查点断点续跑与待处理项人工指派。
 *
 * 核心规则：
 * 1. 批次号幂等：相同批次号重复导入只追加新行，不重复建档；整行内容相同只处理一次。
 * 2. 同测点多条读数并列保留，不自动取舍、不覆盖首录值。
 * 3. 测点存在已确认判定时，新实测值不改写测点主值与判定，只并列新建留痕。
 * 4. 逐条独立事务推进检查点；写入失败保留 checkpoint 与失败行，重试同批次从断点继续。
 */
import { derived, get, writable } from 'svelte/store'
import { db, createId, watchTable } from '$lib/utils/db'
import type { Building } from '$lib/types/building'
import type { Device, DeviceType } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import { defaultBasis, judgePoint } from '$lib/types/verdict'
import type { Batch, BatchInputRow, Reading, ReadingAction, ReadingStatus } from '$lib/types/batch'
import { readingRowKey } from '$lib/types/batch'
import { suggestLimitOhm } from '$lib/utils/resistance'

/** 响应式批次档案与读数 */
export const batchList = writable<Batch[]>([])
export const readingList = writable<Reading[]>([])
export const batchReady = writable(false)

watchTable<Batch>(() => db.batches).subscribe((rows) => {
  batchList.set(rows)
  batchReady.set(true)
})
watchTable<Reading>(() => db.readings).subscribe((rows) => {
  readingList.set(rows)
})

/** 每个批次的挂接结果统计 */
export interface BatchSummary {
  batch: Batch
  total: number
  queued: number
  attached: number
  pending: number
  failed: number
  ignored: number
  /** 断点进度百分比 */
  progressPct: number
}

export const batchSummaries = derived([batchList, readingList], ([$batches, $readings]) =>
  [...$batches]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((batch): BatchSummary => {
      const items = $readings.filter((reading) => reading.batchId === batch.id)
      const count = (status: ReadingStatus): number => items.filter((reading) => reading.status === status).length
      const total = items.length
      return {
        batch,
        total,
        queued: count('queued'),
        attached: count('attached'),
        pending: count('pending'),
        failed: count('failed'),
        ignored: count('ignored'),
        progressPct: total === 0 ? 0 : Math.round((batch.checkpointIndex / Math.max(batch.totalRows, total)) * 100)
      }
    })
)

/** 全部待人工处理的读数 */
export const pendingReadings = derived(readingList, ($readings) =>
  $readings.filter((reading) => reading.status === 'pending' || reading.status === 'failed')
)

/** 全部未完成（processing / failed）的批次 */
export const resumableBatches = derived(batchSummaries, ($summaries) =>
  $summaries.filter(
    (summary) => summary.batch.status !== 'completed' || summary.failed > 0 || summary.queued > 0
  )
)

export function readingsOfBatch(batchId: string): Reading[] {
  return get(readingList)
    .filter((reading) => reading.batchId === batchId)
    .sort((a, b) => a.rowOrder - b.rowOrder)
}

export function getBatchByNo(batchNo: string): Batch | undefined {
  return get(batchList).find((batch) => batch.batchNo === batchNo.trim())
}

/* ----------------------------- 数据快照装载 ----------------------------- */

interface Snapshot {
  devices: Device[]
  buildings: Building[]
  points: Point[]
  readings: Reading[]
  deviceById: Map<string, Device>
  buildingById: Map<string, Building>
}

async function loadSnapshot(): Promise<Snapshot> {
  const [devices, buildings, points, readings] = await Promise.all([
    db.devices.toArray(),
    db.buildings.toArray(),
    db.points.toArray(),
    db.readings.toArray()
  ])
  return {
    devices,
    buildings,
    points,
    readings,
    deviceById: new Map(devices.map((device) => [device.id, device])),
    buildingById: new Map(buildings.map((building) => [building.id, building]))
  }
}

/** 已确认判定的测点 id 集合（这些测点的实测值/限值不允许被新读数覆盖） */
async function confirmedPointIds(): Promise<Set<string>> {
  const all = await db.verdicts.toArray()
  return new Set(all.filter((verdict) => verdict.confirmed).map((verdict) => verdict.pointId))
}

/* ------------------------------- 挂接决策 ------------------------------- */

interface ResolveContext extends Snapshot {
  batch: Batch
  confirmedIds: Set<string>
  preferredDeviceId?: string | null
}

interface Candidate {
  device: Device
  /** 该装置下同编号测点（如有） */
  point: Point | null
}

/** 取某建筑物/全局范围内、指定编号与装置类型的候选测点所在装置；建筑范围无结果时回退全局 */
function findCandidates(snap: Snapshot, reading: Reading, buildingId: string | null): Candidate[] {
  const inScope = (scopeId: string | null) =>
    (scopeId ? snap.devices.filter((device) => device.buildingId === scopeId) : snap.devices)
      .filter((device) => device.type === reading.deviceType)
      .map((device) => ({
        device,
        point: snap.points.find((point) => point.deviceId === device.id && point.code === reading.code) ?? null
      }))
      .filter((candidate) => candidate.point !== null)

  const scoped = inScope(buildingId)
  if (scoped.length > 0 || !buildingId) return scoped
  return inScope(null)
}

/** 取范围内指定类型的装置（编号测点尚不存在时用于新建）；建筑范围无装置时回退全局 */
function findTypedDevices(snap: Snapshot, deviceType: DeviceType, buildingId: string | null): Device[] {
  const inScope = (scopeId: string | null) =>
    (scopeId ? snap.devices.filter((device) => device.buildingId === scopeId) : snap.devices).filter(
      (device) => device.type === deviceType
    )
  const scoped = inScope(buildingId)
  if (scoped.length > 0 || !buildingId) return scoped
  return inScope(null)
}

/** 同批次、同编号、同装置类型已挂接的读数（挂回原记录的首要依据）；直接查库快照，避免 liveQuery 延迟 */
function sameBatchHooks(ctx: ResolveContext, reading: Reading): Reading[] {
  return ctx.readings.filter(
    (item) =>
      item.batchId === reading.batchId &&
      item.status === 'attached' &&
      item.code === reading.code &&
      item.deviceType === reading.deviceType &&
      item.pointId !== null
  )
}

/** 限值缺省时按候选装置所属建筑类别与装置类型建议 */
function resolveLimitOhm(ctx: ResolveContext, device: Device, given: number | null): number {
  if (given !== null && given > 0) return given
  const building = ctx.buildingById.get(device.buildingId)
  return suggestLimitOhm(building?.protectionClass ?? '三类', device.type)
}

type Decision =
  | { kind: 'attach-existing'; device: Device; point: Point }
  | { kind: 'create-point'; device: Device; ordinal: number }
  | { kind: 'parallel'; device: Device; ordinal: number; protected: boolean }
  | { kind: 'pending'; reason: string }

/**
 * 挂接决策：
 * 先看同批次已挂读数 → 再按编号+装置类型匹配既有测点 → 唯一同类型装置则新建 → 否则待人工指派。
 */
function decide(ctx: ResolveContext, reading: Reading): Decision {
  // 1) 本批次已经挂过同编号同类型读数：挂回原记录；数值不同则在同一装置并列新建
  const hooks = sameBatchHooks(ctx, reading)
  if (hooks.length > 0) {
    const hookDeviceId = hooks[0].deviceId
    const device = ctx.deviceById.get(hookDeviceId ?? '')
    const hookPoint = ctx.points.find((point) => point.id === hooks[0].pointId)
    if (device && hookPoint) {
      const targetLimit = resolveLimitOhm(ctx, device, reading.limitOhm)
      const sameValue = hooks.some(
        (item) => item.measuredOhm === reading.measuredOhm && item.limitOhm === targetLimit
      )
      if (sameValue) {
        // 内容完全相同（含已确认测点）：直接挂回原记录，不新建、不改写
        return { kind: 'attach-existing', device, point: hookPoint }
      }
      const ordinal =
        ctx.points.filter((point) => point.deviceId === device.id && point.code === reading.code).length + 1
      const isProtected = ctx.confirmedIds.has(hookPoint.id)
      return { kind: 'parallel', device, ordinal, protected: isProtected }
    }
  }

  // 2) 人工/导入指定了优先装置：直接在其下挂接或新建（类型必须一致）
  if (ctx.preferredDeviceId) {
    const preferred = ctx.deviceById.get(ctx.preferredDeviceId)
    if (preferred && preferred.type === reading.deviceType) {
      const point = ctx.points.find((item) => item.deviceId === preferred.id && item.code === reading.code) ?? null
      if (point) return decideAgainstPoint(ctx, reading, preferred, point)
      return { kind: 'create-point', device: preferred, ordinal: 1 }
    }
  }

  // 3) 按编号 + 装置类型在批次建筑范围（或全局）找既有测点
  const candidates = findCandidates(ctx, reading, ctx.batch.buildingId)
  if (candidates.length === 1 && candidates[0].point) {
    return decideAgainstPoint(ctx, reading, candidates[0].device, candidates[0].point)
  }
  if (candidates.length > 1) {
    return {
      kind: 'pending',
      reason: `测点编号「${reading.code}」在 ${candidates.length} 个${reading.deviceType}装置上都存在，无法自动判定归属，请人工指派`
    }
  }

  // 4) 没有既有测点：范围内同类型装置唯一才自动新建，否则待处理
  const typed = findTypedDevices(ctx, reading.deviceType, ctx.batch.buildingId)
  if (typed.length === 1) {
    return { kind: 'create-point', device: typed[0], ordinal: 1 }
  }
  if (typed.length === 0) {
    return {
      kind: 'pending',
      reason: `未登记「${reading.deviceType}」类型的装置${ctx.batch.buildingId ? '（当前批次建筑物范围内）' : ''}，请先登记装置或人工指派`
    }
  }
  return {
    kind: 'pending',
    reason: `范围内有 ${typed.length} 个${reading.deviceType}装置，测点编号「${reading.code}」尚无档案，请人工指派归属装置`
  }
}

/** 命中既有测点：同值挂回；不同值时已确认判定锁定、并列保留，未确认则刷新初判 */
function decideAgainstPoint(ctx: ResolveContext, reading: Reading, device: Device, point: Point): Decision {
  const incomingLimit = resolveLimitOhm(ctx, device, reading.limitOhm)
  const sameValue = point.measuredOhm === reading.measuredOhm && point.limitOhm === incomingLimit
  // 值完全相同（含已确认测点）：只是再次挂回原记录，不新建、不改写
  if (sameValue) {
    return { kind: 'attach-existing', device, point }
  }
  // 值不同且判定已确认：主值与结论锁定，读数并列留痕
  if (ctx.confirmedIds.has(point.id)) {
    const ordinal = ctx.points.filter((item) => item.deviceId === device.id && item.code === reading.code).length + 1
    return { kind: 'parallel', device, ordinal, protected: true }
  }
  // 值不同且未确认：直接刷新该测点实测值（编号相同即同一测点），判定回退为待确认初判
  return { kind: 'attach-existing', device, point }
}

/* ------------------------------- 逐条处理 ------------------------------- */

interface ProcessResult {
  /** 本批新增挂接/新建数 */
  attached: number
  /** 并列新建数 */
  parallel: number
  /** 待人工处理数 */
  pending: number
  /** 写入失败数（>0 即中断） */
  failed: number
  /** 断点停止行序（完成时为总数） */
  stoppedAt: number
  error: string
}

/**
 * 从检查点继续处理批次内 queued / failed 读数。
 * 每条读数一个独立事务：提交即推进 checkpoint，异常即停并保留断点。
 */
export async function processBatch(batchId: string, preferredDeviceId: string | null = null): Promise<ProcessResult> {
  const result: ProcessResult = { attached: 0, parallel: 0, pending: 0, failed: 0, stoppedAt: 0, error: '' }
  const batch = await db.batches.get(batchId)
  if (!batch) return result

  const pendingRows = (await db.readings
    .where('batchId')
    .equals(batchId)
    .toArray())
    .filter((reading) => reading.status === 'queued' || reading.status === 'failed')
    .sort((a, b) => a.rowOrder - b.rowOrder)

  for (const reading of pendingRows) {
    // 重新装载快照：前序读数可能已新建测点/装置关联
    const snap = await loadSnapshot()
    const confirmedIds = await confirmedPointIds()
    const ctx: ResolveContext = { ...snap, batch, confirmedIds, preferredDeviceId }
    try {
      const decision = decide(ctx, reading)
      await db.transaction('rw', [db.readings, db.points, db.verdicts, db.batches], async () => {
        await applyDecision(ctx, reading, decision)
        const nextCheckpoint = Math.max(batch.checkpointIndex, reading.rowOrder + 1)
        await db.batches.update(batchId, {
          checkpointIndex: nextCheckpoint,
          status: 'processing',
          failedAt: null,
          lastError: '',
          updatedAt: Date.now()
        })
      })
      if (decision.kind === 'pending') result.pending += 1
      else if (decision.kind === 'parallel') {
        result.parallel += 1
        result.attached += 1
      } else result.attached += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db.transaction('rw', [db.readings, db.batches], async () => {
        await db.readings.update(reading.id, {
          status: 'failed',
          action: 'none',
          pointId: null,
          deviceId: null,
          reason: `写入失败：${message}`,
          updatedAt: Date.now()
        })
        await db.batches.update(batchId, {
          status: 'failed',
          failedAt: Date.now(),
          lastError: `第 ${reading.rowOrder + 1} 行（${reading.code}）写入失败：${message}`,
          updatedAt: Date.now()
        })
      })
      result.failed += 1
      result.stoppedAt = reading.rowOrder
      result.error = message
      return result
    }
  }

  result.stoppedAt = batch.totalRows
  // 队列跑完：无论是否还有待人工指派项，批次都标记为已处理完成
  const remainPending = await db.readings
    .where('batchId')
    .equals(batchId)
    .toArray()
  const pendingCount = remainPending.filter((reading) => reading.status === 'pending').length
  await db.batches.update(batchId, {
    status: 'completed',
    completedAt: Date.now(),
    failedAt: null,
    lastError: pendingCount > 0 ? `尚有 ${pendingCount} 条读数待人工指派装置` : '',
    updatedAt: Date.now()
  })
  result.pending = pendingCount
  return result
}

/** 在单条读数事务内执行挂接决策并落库 */
async function applyDecision(ctx: ResolveContext, reading: Reading, decision: Decision): Promise<void> {
  const now = Date.now()
  if (decision.kind === 'pending') {
    await db.readings.update(reading.id, {
      status: 'pending',
      action: 'none',
      pointId: null,
      deviceId: null,
      reason: decision.reason,
      updatedAt: now
    })
    return
  }

  const { device } = decision
  const building = ctx.buildingById.get(device.buildingId)
  const limitOhm = resolveLimitOhm(ctx, device, reading.limitOhm)

  if (decision.kind === 'attach-existing') {
    const { point } = decision
    // 已确认判定保护完全由 decide() 决策：值不同会被判定为 parallel 不会走到这里；
    // 走到这里只有两种情况——值相同（原样挂回）或未确认测点（允许刷新主值）。
    if (point.measuredOhm !== reading.measuredOhm || point.limitOhm !== limitOhm || !point.location) {
      await db.points.update(point.id, {
        measuredOhm: reading.measuredOhm,
        limitOhm,
        location: point.location || reading.location,
        meter: reading.meter || point.meter,
        measureDate: reading.measureDate || point.measureDate,
        updatedAt: now
      } as never)
      // 未确认判定随新实测值重新初判；已确认的在此分支之外，不被覆盖
      const verdict = await db.verdicts.where('pointId').equals(point.id).first()
      if (verdict && !verdict.confirmed) {
        await db.verdicts.put({
          ...verdict,
          result: judgePoint(reading.measuredOhm, limitOhm),
          limitOhm,
          basis: defaultBasis(building?.protectionClass ?? '三类', device.type, limitOhm),
          verdictDate: reading.measureDate || verdict.verdictDate,
          updatedAt: now
        })
      }
    }
    await db.readings.update(reading.id, {
      status: 'attached',
      action: 'matched-existing',
      pointId: point.id,
      deviceId: device.id,
      limitOhm,
      reason: `挂回既有测点（${device.type}）`,
      updatedAt: now
    })
    return
  }

  if (decision.kind === 'create-point') {
    await createPointWithReading(ctx, reading, device, limitOhm, building?.protectionClass ?? '三类', 1, 'created-point', now)
    return
  }

  // parallel：同测点多条读数并列新建（可能因判定已确认而锁定）
  await attachParallel(ctx, reading, device, limitOhm, building?.protectionClass ?? '三类', decision.protected, decision.ordinal)
}

/** 并列新建测点 + 未确认初判，读数与新测点互相挂接 */
async function attachParallel(
  ctx: ResolveContext,
  reading: Reading,
  device: Device,
  limitOhm: number,
  protectionClass: Building['protectionClass'],
  isProtected: boolean,
  ordinal?: number
): Promise<void> {
  const sameCodeCount = ctx.points.filter((point) => point.deviceId === device.id && point.code === reading.code).length
  await createPointWithReading(
    ctx,
    reading,
    device,
    limitOhm,
    protectionClass,
    ordinal ?? sameCodeCount + 1,
    isProtected ? 'protected-point' : 'parallel-point',
    Date.now()
  )
}

async function createPointWithReading(
  ctx: ResolveContext,
  reading: Reading,
  device: Device,
  limitOhm: number,
  protectionClass: Building['protectionClass'],
  ordinal: number,
  action: ReadingAction,
  now: number
): Promise<void> {
  const pointId = createId('pnt')
  const point: Point = {
    id: pointId,
    deviceId: device.id,
    code: reading.code,
    location: reading.location,
    measuredOhm: reading.measuredOhm,
    limitOhm,
    meter: reading.meter || ctx.batch.meter,
    measureDate: reading.measureDate || ctx.batch.measureDate,
    batchNo: reading.batchNo,
    readingOrdinal: ordinal,
    createdAt: now,
    updatedAt: now
  }
  // 新测点自动初判但不确认生效，等待检测人在判定台确认
  const verdict: Verdict = {
    id: `vrd_${pointId}`,
    pointId,
    result: judgePoint(reading.measuredOhm, limitOhm),
    limitOhm,
    basis: defaultBasis(protectionClass, device.type, limitOhm),
    inspector: '',
    verdictDate: point.measureDate,
    confirmed: false,
    createdAt: now,
    updatedAt: now
  }
  await db.points.put(point)
  await db.verdicts.put(verdict)
  await db.readings.update(reading.id, {
    status: 'attached',
    action,
    pointId,
    deviceId: device.id,
    limitOhm,
    reason:
      action === 'protected-point'
        ? '原测点判定已确认，实测值锁定不改写，读数并列新建留痕'
        : action === 'parallel-point'
          ? '同一测点同批次出现多条读数，并列保留，未自动取舍'
          : `在唯一${device.type}装置下新建测点`,
    updatedAt: now
  })
}

/* ------------------------------- 导入入口 ------------------------------- */

export interface StartBatchOptions {
  batchNo: string
  sourceName: string
  meter: string
  measureDate: string
  buildingId: string | null
  /** 页面上选定了具体装置时作为唯一挂接/新建目标 */
  preferredDeviceId?: string | null
  note?: string
}

export interface StartBatchResult {
  batchId: string
  reused: boolean
  inserted: number
  duplicated: number
  process: ProcessResult
}

/**
 * 导入一批读数：
 * - 批次号已存在 → 追加到原批次（不重复建档），整行重复直接跳过；
 * - 新批次建档后从断点 0 开始处理。
 */
export async function startBatchImport(rows: BatchInputRow[], options: StartBatchOptions): Promise<StartBatchResult> {
  const batchNo = options.batchNo.trim()
  if (!batchNo) throw new Error('批次号不能为空')
  const now = Date.now()

  const existingBatch = await db.batches.where('batchNo').equals(batchNo).first()
  const reused = existingBatch !== undefined
  const batchId = existingBatch?.id ?? createId('bat')

  if (existingBatch) {
    await db.batches.update(batchId, {
      status: 'processing',
      sourceName: options.sourceName || existingBatch.sourceName,
      meter: options.meter || existingBatch.meter,
      measureDate: options.measureDate || existingBatch.measureDate,
      buildingId: options.buildingId ?? existingBatch.buildingId,
      lastError: '',
      failedAt: null,
      updatedAt: now
    })
  } else {
    const row: Batch = {
      id: batchId,
      batchNo,
      status: 'processing',
      sourceName: options.sourceName,
      meter: options.meter,
      measureDate: options.measureDate,
      totalRows: 0,
      duplicatedRows: 0,
      checkpointIndex: 0,
      lastError: '',
      buildingId: options.buildingId,
      note: options.note ?? '',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      failedAt: null
    }
    await db.batches.put(row)
  }

  const existing = await db.readings.where('batchId').equals(batchId).toArray()
  const existingKeys = new Set(existing.map((reading) => reading.rowKey))
  let nextOrder = existing.reduce((max, reading) => Math.max(max, reading.rowOrder + 1), 0)

  const fresh: Reading[] = []
  let duplicated = 0
  for (const row of rows) {
    const rowKey = readingRowKey(batchNo, row)
    if (existingKeys.has(rowKey)) {
      duplicated += 1
      continue
    }
    existingKeys.add(rowKey)
    fresh.push({
      id: createId('rdg'),
      batchId,
      batchNo,
      rowOrder: nextOrder++,
      rowKey,
      code: row.code,
      deviceType: row.deviceType,
      measuredOhm: row.measuredOhm,
      limitOhm: row.limitOhm,
      location: row.location,
      meter: row.meter || options.meter,
      measureDate: options.measureDate,
      status: 'queued',
      action: 'none',
      pointId: null,
      deviceId: null,
      reason: '',
      createdAt: now,
      updatedAt: now
    })
  }
  if (fresh.length > 0) await db.readings.bulkPut(fresh)
  await db.batches.update(batchId, {
    totalRows: nextOrder,
    duplicatedRows: (existingBatch?.duplicatedRows ?? 0) + duplicated,
    updatedAt: now
  })

  const process = await processBatch(batchId, options.preferredDeviceId ?? null)
  return { batchId, reused, inserted: fresh.length, duplicated, process }
}

/** 重试同一批次：失败行重置为 queued，从断点继续处理 */
export async function retryBatch(batchId: string, preferredDeviceId: string | null = null): Promise<ProcessResult> {
  const now = Date.now()
  await db.transaction('rw', [db.batches, db.readings], async () => {
    await db.batches.update(batchId, { status: 'processing', lastError: '', failedAt: null, updatedAt: now })
    const failed = await db.readings.where('batchId').equals(batchId).toArray()
    for (const reading of failed) {
      if (reading.status === 'failed') {
        await db.readings.update(reading.id, { status: 'queued', reason: '', updatedAt: now })
      }
    }
  })
  return processBatch(batchId, preferredDeviceId)
}

/** 人工指派待处理读数的归属装置后立即挂接 */
export async function resolveReadingAssign(readingId: string, deviceId: string): Promise<void> {
  const reading = await db.readings.get(readingId)
  if (!reading) return
  const device = await db.devices.get(deviceId)
  if (!device) throw new Error('所选装置不存在')
  if (device.type !== reading.deviceType) {
    throw new Error(`装置类型不符：该读数为「${reading.deviceType}」，所选装置为「${device.type}」`)
  }
  const batch = await db.batches.get(reading.batchId)
  if (!batch) return
  const now = Date.now()
  await db.readings.update(readingId, {
    status: 'queued',
    action: 'none',
    pointId: null,
    deviceId: null,
    reason: '',
    updatedAt: now
  })
  const snap = await loadSnapshot()
  const confirmedIds = await confirmedPointIds()
  const ctx: ResolveContext = { ...snap, batch, confirmedIds, preferredDeviceId: deviceId }
  const decision = decide(ctx, reading)
  await db.transaction('rw', [db.readings, db.points, db.verdicts], async () => {
    await applyDecision(ctx, reading, decision)
    // 人工指派结果覆盖动作为 manual-assign
    const latest = await db.readings.get(readingId)
    if (latest && latest.status === 'attached') {
      await db.readings.update(readingId, { action: 'manual-assign', updatedAt: Date.now() })
    }
  })
  await refreshBatchState(batch.id)
}

/** 人工确认读数不属于本台账：忽略但留痕 */
export async function ignoreReading(readingId: string): Promise<void> {
  const reading = await db.readings.get(readingId)
  if (!reading) return
  await db.readings.update(readingId, {
    status: 'ignored',
    action: 'none',
    pointId: null,
    deviceId: null,
    reason: reading.reason || '人工确认忽略',
    updatedAt: Date.now()
  })
  await refreshBatchState(reading.batchId)
}

/** 把被忽略/挂错的读数恢复为待处理，重新指派 */
export async function reopenReading(readingId: string): Promise<void> {
  const reading = await db.readings.get(readingId)
  if (!reading) return
  await db.readings.update(readingId, {
    status: 'pending',
    action: 'none',
    pointId: null,
    deviceId: null,
    reason: '已重新打开，等待人工指派',
    updatedAt: Date.now()
  })
  await refreshBatchState(reading.batchId)
}

/** 读数处理后回写批次聚合状态 */
async function refreshBatchState(batchId: string): Promise<void> {
  const readings = await db.readings.where('batchId').equals(batchId).toArray()
  const hasUnfinished = readings.some((reading) => reading.status === 'queued' || reading.status === 'failed')
  const pendingCount = readings.filter((reading) => reading.status === 'pending').length
  await db.batches.update(batchId, {
    status: hasUnfinished ? 'processing' : 'completed',
    completedAt: hasUnfinished ? null : Date.now(),
    lastError: pendingCount > 0 ? `尚有 ${pendingCount} 条读数待人工指派装置` : '',
    updatedAt: Date.now()
  })
}

/**
 * 删除批次对账档案：默认只删批次与读数留痕，已挂接生成的测点/判定/整改保留可查；
 * deletePoints=true 时连同本批次新建（非初始批次回填、非首录）的并列测点一并删除。
 */
export async function removeBatch(batchId: string, deletePoints = false): Promise<void> {
  await db.transaction('rw', [db.batches, db.readings, db.points, db.verdicts], async () => {
    const readings = await db.readings.where('batchId').equals(batchId).toArray()
    if (deletePoints) {
      // 仅删除由本批次新建的测点；matched-existing / manual-assign 挂回的既有测点一律保留
      const removablePointIds = readings
        .filter(
          (reading) =>
            reading.action === 'created-point' ||
            reading.action === 'parallel-point' ||
            reading.action === 'protected-point'
        )
        .map((reading) => reading.pointId)
        .filter((id): id is string => id !== null)
      const unique = [...new Set(removablePointIds)]
      if (unique.length > 0) {
        await db.verdicts.where('pointId').anyOf(unique).delete()
        await db.points.bulkDelete(unique)
      }
    }
    await db.readings.where('batchId').equals(batchId).delete()
    await db.batches.delete(batchId)
  })
}
