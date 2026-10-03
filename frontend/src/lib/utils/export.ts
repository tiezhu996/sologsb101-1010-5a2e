/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致；JSON 中不含任何非数据内容。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '$lib/utils/db'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import { LEGACY_BATCH_ID, LEGACY_BATCH_NO } from '$lib/types/batch'

/** 备份集合键名 */
export const BACKUP_KEYS = ['buildings', 'devices', 'points', 'verdicts', 'rectifies', 'batches', 'readings'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [buildings, devices, points, verdicts, rectifies, batches, readings] = await Promise.all([
    db.buildings.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.verdicts.toArray(),
    db.rectifies.toArray(),
    db.batches.toArray(),
    db.readings.toArray()
  ])
  return {
    app: 'gblightprot',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    buildings,
    devices,
    points,
    verdicts,
    rectifies,
    batches,
    readings
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gblightprot') {
    errors.push('app 字段应为 gblightprot，文件来源不明')
  }
  // batches / readings 为 v3 新增：旧备份没有时允许，按兼容规则回填
  for (const key of ['buildings', 'devices', 'points', 'verdicts', 'rectifies'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gblightprot',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    buildings: obj.buildings ?? [],
    devices: obj.devices ?? [],
    points: normalizePoints(obj.points ?? []),
    verdicts: normalizeVerdicts(obj.verdicts ?? [], obj.points ?? []),
    rectifies: obj.rectifies ?? [],
    batches: Array.isArray(obj.batches) ? obj.batches : [],
    readings: Array.isArray(obj.readings) ? obj.readings : []
  }
  return { ok: true, errors, payload }
}

/** 旧备份测点补齐批次来源与并列序号 */
function normalizePoints(points: Point[]): Point[] {
  return points.map((point) => ({
    ...point,
    batchNo: point.batchNo || LEGACY_BATCH_NO,
    readingOrdinal: typeof point.readingOrdinal === 'number' ? point.readingOrdinal : 1
  }))
}

/** 旧备份判定补齐确认时限值快照 */
function normalizeVerdicts(verdicts: Verdict[], points: Point[]): Verdict[] {
  const limitOfPoint = new Map(points.map((point) => [point.id, point.limitOhm]))
  return verdicts.map((verdict) => ({
    ...verdict,
    limitOhm: typeof verdict.limitOhm === 'number' ? verdict.limitOhm : limitOfPoint.get(verdict.pointId) ?? 10
  }))
}

/**
 * 兼容规则：导入数据没有批次来源时，把测点/判定归入初始批次，
 * 原有测点、判定与整改均原样保留可查。
 */
export function ensureLegacyBatch(payload: BackupPayload): BackupPayload {
  const legacyPoints = payload.points.filter((point) => !point.batchNo || point.batchNo === LEGACY_BATCH_NO)
  if (legacyPoints.length === 0 || payload.batches.some((batch) => batch.id === LEGACY_BATCH_ID)) {
    return { ...payload, points: normalizePoints(payload.points), verdicts: normalizeVerdicts(payload.verdicts, payload.points) }
  }
  const now = Date.now()
  const deviceTypeOf = new Map(
    payload.devices.map((device) => [device.id, device.type])
  )
  const readings = legacyPoints.map((point, index) => ({
    id: `rdg_legacy_import_${index}_${point.id}`.slice(0, 80),
    batchId: LEGACY_BATCH_ID,
    batchNo: LEGACY_BATCH_NO,
    rowOrder: index,
    rowKey: [LEGACY_BATCH_NO, point.code, deviceTypeOf.get(point.deviceId) ?? '接地体', point.measuredOhm, point.limitOhm, point.location].join('|'),
    code: point.code,
    deviceType: deviceTypeOf.get(point.deviceId) ?? '接地体',
    measuredOhm: point.measuredOhm,
    limitOhm: point.limitOhm,
    location: point.location,
    meter: point.meter ?? '',
    measureDate: point.measureDate ?? '',
    status: 'attached' as const,
    action: 'migrated-legacy' as const,
    pointId: point.id,
    deviceId: point.deviceId,
    reason: '旧数据（无批次来源）导入时回填初始批次',
    createdAt: point.createdAt ?? now,
    updatedAt: point.updatedAt ?? now
  }))
  return {
    ...payload,
    points: normalizePoints(payload.points),
    verdicts: normalizeVerdicts(payload.verdicts, payload.points),
    batches: [
      ...payload.batches,
      {
        id: LEGACY_BATCH_ID,
        batchNo: LEGACY_BATCH_NO,
        status: 'completed' as const,
        sourceName: '旧备份兼容回填',
        meter: '',
        measureDate: '',
        totalRows: legacyPoints.length,
        duplicatedRows: 0,
        checkpointIndex: legacyPoints.length,
        lastError: '',
        buildingId: null,
        note: '导入无批次来源的旧备份时自动生成，测点、判定与整改原样保留。',
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        failedAt: null
      }
    ],
    readings: [...payload.readings, ...readings]
  }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    buildings: payload.buildings.length,
    devices: payload.devices.length,
    points: payload.points.length,
    verdicts: payload.verdicts.length,
    rectifies: payload.rectifies.length,
    batches: payload.batches.length,
    readings: payload.readings.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  const normalized = ensureLegacyBatch(payload)
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.buildings, db.devices, db.points, db.verdicts, db.rectifies, db.batches, db.readings],
    async () => {
      await db.buildings.bulkPut(normalized.buildings)
      await db.devices.bulkPut(normalized.devices)
      await db.points.bulkPut(normalized.points)
      await db.verdicts.bulkPut(normalized.verdicts)
      await db.rectifies.bulkPut(normalized.rectifies)
      await db.batches.bulkPut(normalized.batches)
      await db.readings.bulkPut(normalized.readings)
    }
  )
  return countPayload(normalized)
}

/**
 * 追加式导入：为导入数据重新分配 id，避免覆盖现有档案。
 * 批次号若与本地已有批次冲突，追加「-导入」后缀以保证批次档案可区分、可对账。
 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const buildingMap = new Map<string, string>()
  const deviceMap = new Map<string, string>()
  const pointMap = new Map<string, string>()
  const batchMap = new Map<string, string>()
  const batchNoMap = new Map<string, string>()

  const buildings = payload.buildings.map((building) => {
    const id = createId('bld')
    buildingMap.set(building.id, id)
    return { ...building, id }
  })
  const devices = payload.devices.map((device) => {
    const id = createId('dev')
    deviceMap.set(device.id, id)
    return { ...device, id, buildingId: buildingMap.get(device.buildingId) ?? device.buildingId }
  })
  const points = payload.points.map((point) => {
    const id = createId('pnt')
    pointMap.set(point.id, id)
    return { ...point, id, deviceId: deviceMap.get(point.deviceId) ?? point.deviceId }
  })
  const verdicts = payload.verdicts.map((verdict) => ({
    ...verdict,
    id: createId('vrd'),
    pointId: pointMap.get(verdict.pointId) ?? verdict.pointId
  }))
  const rectifies = payload.rectifies.map((rectify) => ({
    ...rectify,
    id: createId('rct'),
    buildingId: buildingMap.get(rectify.buildingId) ?? rectify.buildingId,
    pointId: rectify.pointId ? pointMap.get(rectify.pointId) ?? rectify.pointId : null
  }))
  const batches = payload.batches.map((batch) => {
    const id = createId('bat')
    batchMap.set(batch.id, id)
    const nextBatchNo = batch.batchNo ? `${batch.batchNo}-导入` : batch.batchNo
    batchNoMap.set(batch.id, nextBatchNo)
    return { ...batch, id, batchNo: nextBatchNo, status: 'completed' as const }
  })
  const readings = payload.readings.map((reading) => ({
    ...reading,
    id: createId('rdg'),
    batchId: batchMap.get(reading.batchId) ?? reading.batchId,
    batchNo: batchNoMap.get(reading.batchId) ?? reading.batchNo,
    pointId: reading.pointId ? pointMap.get(reading.pointId) ?? reading.pointId : null,
    deviceId: reading.deviceId ? deviceMap.get(reading.deviceId) ?? reading.deviceId : null
  }))
  return { ...payload, buildings, devices, points, verdicts, rectifies, batches, readings }
}

/** 检测结论行：按建筑物汇总测点数、不合格数与结论文字 */
export interface ConclusionLine {
  buildingId: string
  buildingName: string
  usage: string
  protectionClass: string
  deviceCount: number
  pointCount: number
  unqualifiedCount: number
  qualifyRatePct: number
  /** 最不利（实测/限值比最大）测点摘要 */
  worstPoint: string
  conclusion: string
  advice: string
}

/** 生成按建筑物的检测结论与整改建议汇总 */
export function buildConclusionLines(payload: BackupPayload): ConclusionLine[] {
  const deviceById = new Map(payload.devices.map((device) => [device.id, device]))
  const verdictByPoint = new Map(payload.verdicts.map((verdict) => [verdict.pointId, verdict]))

  return payload.buildings.map((building) => {
    const devices = payload.devices.filter((device) => device.buildingId === building.id)
    const deviceIds = new Set(devices.map((device) => device.id))
    const points = payload.points.filter((point) => deviceIds.has(point.deviceId))
    const verdicts = points
      .map((point) => verdictByPoint.get(point.id))
      .filter((verdict): verdict is NonNullable<typeof verdict> => Boolean(verdict))
    const unqualified = verdicts.filter((verdict) => verdict.result === '不合格')
    let worstRatio = 0
    let worstPoint = '无测点数据'
    points.forEach((point) => {
      const ratio = point.limitOhm > 0 ? point.measuredOhm / point.limitOhm : 0
      if (ratio > worstRatio) {
        worstRatio = ratio
        const device = deviceById.get(point.deviceId)
        worstPoint = `${point.code}（${device?.type ?? '装置'}）实测 ${point.measuredOhm} Ω / 限值 ${point.limitOhm} Ω`
      }
    })
    const qualifyRatePct =
      verdicts.length === 0
        ? 0
        : Number((((verdicts.length - unqualified.length) / verdicts.length) * 100).toFixed(1))
    const rectifies = payload.rectifies.filter((rectify) => rectify.buildingId === building.id)
    const pending = rectifies.filter((rectify) => rectify.state !== '已复检').length
    const conclusion =
      points.length === 0
        ? '未录入测点，无法出具结论'
        : unqualified.length === 0
          ? `所检 ${points.length} 个测点接地电阻均不大于限值，判定合格`
          : `所检 ${points.length} 个测点中 ${unqualified.length} 个不合格，判定不合格`
    const advice =
      rectifies.length === 0
        ? '无需整改，建议按周期复测'
        : `已生成 ${rectifies.length} 条整改建议，其中 ${pending} 条未完成复检闭环`
    return {
      buildingId: building.id,
      buildingName: building.name,
      usage: building.usage,
      protectionClass: building.protectionClass,
      deviceCount: devices.length,
      pointCount: points.length,
      unqualifiedCount: unqualified.length,
      qualifyRatePct,
      worstPoint,
      conclusion,
      advice
    }
  })
}
