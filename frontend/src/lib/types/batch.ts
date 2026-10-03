/**
 * 批次对账类型：外场带回的同一批次接地电阻数据按「批次号 + 测点编号 + 设备类型」挂回档案。
 *
 * - Batch：一次导入的批次档案（批次号唯一、幂等、可断点续跑）
 * - Reading：批次内逐条实测读数，同一测点多条并列保留，不自动取舍
 */
import type { DeviceType } from '$lib/types/device'
import { DEVICE_TYPES } from '$lib/types/device'

/** 旧数据（无批次来源）兼容回填使用的初始批次号 */
export const LEGACY_BATCH_NO = '初始批次'
export const LEGACY_BATCH_ID = 'bat_legacy'

/** 批次处理状态 */
export type BatchStatus = 'processing' | 'completed' | 'failed'

/**
 * 单条读数的处理状态：
 * - queed    已落库等待处理（断点位置之前不会存在）
 * - attached 已挂接到测点（含挂回既有测点 / 新建测点 / 并列新建）
 * - pending  无法自动挂接（找不到装置或编号歧义），等待人工指派
 * - failed   处理时写入失败，等待从断点重试
 * - ignored  人工确认不属于本台账，忽略留痕
 */
export type ReadingStatus = 'queued' | 'attached' | 'pending' | 'failed' | 'ignored'

/** 挂接动作（挂接结果明细，供页面展示与审计） */
export type ReadingAction =
  | 'matched-existing' // 挂回同批次/同编号既有测点
  | 'created-point' // 在唯一匹配装置下新建测点
  | 'parallel-point' // 同测点多条读数并列新建，未覆盖原值
  | 'protected-point' // 原测点判定已确认，锁定不改写，并列新建
  | 'migrated-legacy' // 旧数据回填初始批次
  | 'manual-assign' // 人工指派装置后挂接
  | 'none' // 未挂接（pending / failed / ignored）

/** 批次档案：按批次号幂等，相同批次重复导入只追加新行，不会重复建档 */
export interface Batch {
  id: string
  /** 批次号（业务对账键，档案内唯一） */
  batchNo: string
  status: BatchStatus
  /** 来源文件名或手记说明 */
  sourceName: string
  meter: string
  measureDate: string
  /** 行总数（去重后的并集，随重复导入增长） */
  totalRows: number
  /** 整行重复、本次直接跳过的行数累计 */
  duplicatedRows: number
  /** 已自动处理到的行序（断点：失败时停在未完成行） */
  checkpointIndex: number
  /** 最后一次写入失败说明 */
  lastError: string
  /** 挂接范围：指定建筑物（可空表示全局匹配） */
  buildingId: string | null
  note: string
  createdAt: number
  updatedAt: number
  completedAt: number | null
  failedAt: number | null
}

/** 批次内一条实测读数（原始留痕，并列保留） */
export interface Reading {
  id: string
  batchId: string
  /** 冗余批次号，便于直接索引与备份核对 */
  batchNo: string
  /** 行序（文件内从 0 开始，断点按此续跑） */
  rowOrder: number
  /** 整行幂等键：批次号 + 编号 + 设备类型 + 实测 + 限值 + 位置 */
  rowKey: string
  code: string
  deviceType: DeviceType
  measuredOhm: number
  limitOhm: number | null
  location: string
  meter: string
  measureDate: string
  status: ReadingStatus
  action: ReadingAction
  /** 挂接到的测点（pending/failed 时为 null） */
  pointId: string | null
  /** 挂接归属装置 */
  deviceId: string | null
  /** 未挂接原因 / 挂接说明 / 失败信息 */
  reason: string
  createdAt: number
  updatedAt: number
}

/** 解析后的批次导入行 */
export interface BatchInputRow {
  code: string
  deviceType: DeviceType
  measuredOhm: number
  limitOhm: number | null
  location: string
  meter: string
}

/** 设备类型常见手记别名归一化 */
const DEVICE_TYPE_ALIASES: Record<string, DeviceType> = {
  接闪带: '接闪带',
  避雷带: '接闪带',
  接闪器: '接闪带',
  接闪杆: '接闪杆',
  避雷针: '接闪杆',
  引下线: '引下线',
  接地体: '接地体',
  接地装置: '接地体',
  接地极: '接地体',
  接地网: '接地体',
  接地: '接地体'
}

export function normalizeDeviceType(text: string): DeviceType | null {
  const trimmed = text.trim()
  if ((DEVICE_TYPES as readonly string[]).includes(trimmed)) return trimmed as DeviceType
  return DEVICE_TYPE_ALIASES[trimmed] ?? null
}

/**
 * 解析批次导入文本，每行：
 * 「测点编号,设备类型,实测电阻[,限值[,位置[,仪器]]]」
 * 逗号 / 制表符 / 分号均可分隔；批次号在页面统一指定，不占列。
 */
export function parseBatchRows(
  text: string,
  fallback: { limitOhm?: number; meter?: string } = {}
): { rows: BatchInputRow[]; errors: string[] } {
  const rows: BatchInputRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「测点编号,设备类型,实测电阻」三列`)
      return
    }
    const code = cells[0]
    if (!code) {
      errors.push(`第 ${index + 1} 行测点编号为空`)
      return
    }
    const deviceType = normalizeDeviceType(cells[1])
    if (!deviceType) {
      errors.push(`第 ${index + 1} 行设备类型「${cells[1]}」无法识别（接闪带 / 接闪杆 / 引下线 / 接地体）`)
      return
    }
    const measuredOhm = Number(cells[2])
    if (!Number.isFinite(measuredOhm) || measuredOhm < 0) {
      errors.push(`第 ${index + 1} 行实测电阻应为非负数字`)
      return
    }
    let limitOhm: number | null = fallback.limitOhm ?? null
    if (cells.length >= 4 && cells[3] !== '') {
      const parsed = Number(cells[3])
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.push(`第 ${index + 1} 行限值应为大于 0 的数字`)
        return
      }
      limitOhm = Number(parsed.toFixed(3))
    }
    if (limitOhm !== null) limitOhm = Number(limitOhm.toFixed(3))
    rows.push({
      code,
      deviceType,
      measuredOhm: Number(measuredOhm.toFixed(3)),
      limitOhm,
      location: cells[4] ?? '',
      meter: cells[5] ?? fallback.meter ?? ''
    })
  })
  return { rows, errors }
}

/** 整行幂等键：同一批次内内容完全相同的行只处理一次 */
export function readingRowKey(
  batchNo: string,
  row: Pick<BatchInputRow, 'code' | 'deviceType' | 'measuredOhm' | 'limitOhm' | 'location'>
): string {
  return [batchNo, row.code, row.deviceType, row.measuredOhm, row.limitOhm ?? '', row.location].join('|')
}

/** 默认批次号建议：PC-YYYYMMDD-01 */
export function suggestBatchNo(date = new Date()): string {
  return `PC-${date.toISOString().slice(0, 10).replace(/-/g, '')}-01`
}
