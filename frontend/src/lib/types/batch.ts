/**
 * 导入批次与批次行：外场接地电阻数据按批次对账挂接。
 *
 * 业务约定：
 * - 「批次号 + 测点编号 + 设备类型」是挂接原记录的业务键；
 * - 批次号全站唯一，相同批次重复导入复用原批次，不会重复建档；
 * - 每一导入行持久化处理状态与断点游标，写入失败后可从断点续传；
 * - 旧数据没有批次来源时，由结构迁移统一回填到「初始批次」。
 */
import { DEVICE_TYPES } from '$lib/types/device'
import type { DeviceType } from '$lib/types/device'

/** 旧数据兼容回填的初始批次号（v3 之前无批次来源的历史记录统一归入） */
export const LEGACY_BATCH_NO = 'INIT-LEGACY'

/** 初始批次固定 id（迁移与播种共用，保证幂等） */
export const LEGACY_BATCH_ID = 'bat_legacy_init'

/** 批次状态机：待处理 → 处理中 → 已完成 / 部分失败（部分失败可重试续传） */
export type BatchState = '待处理' | '处理中' | '已完成' | '部分失败'

export const BATCH_STATES: BatchState[] = ['待处理', '处理中', '已完成', '部分失败']

/** 导入批次：同一批次号只建一次档，重复导入复用 */
export interface ImportBatch {
  id: string
  /** 业务批次号（唯一键），如 PC-20261003-01 */
  batchNo: string
  /** 目标建筑物（新建测点档案时挂到其下；初始批次为空串） */
  buildingId: string
  /** 默认设备类型（行内未指明设备类型时使用） */
  deviceType: DeviceType
  /** 来源说明：外场班组 / 仪器 / 文件名 */
  sourceNote: string
  state: BatchState
  /** 批次内导入行总数 */
  totalRows: number
  /** 已处理完成行数（挂接 / 建档 / 并列 / 跳过） */
  doneRows: number
  /** 处理失败行数 */
  failedRows: number
  /** 断点游标：下一个待处理行号（重试从此继续） */
  cursor: number
  createdAt: number
  updatedAt: number
}

/** 批次行处理状态 */
export type ImportRowState = '待处理' | '已挂接' | '已建档' | '并列保留' | '已跳过' | '失败'

export const IMPORT_ROW_STATES: ImportRowState[] = ['待处理', '已挂接', '已建档', '并列保留', '已跳过', '失败']

/** 导入行：批次明细，持久化处理状态与挂接结果，构成对账依据 */
export interface ImportRow {
  id: string
  /** 所属批次 */
  batchId: string
  /** 批次内行号（从 1 开始，断点续传的游标单位） */
  rowIndex: number
  /** 判重指纹：同批次内内容完全相同的行只保留一条 */
  fingerprint: string
  /** 测点编号 */
  code: string
  /** 设备类型（装置类型） */
  deviceType: DeviceType
  /** 测点位置描述 */
  location: string
  /** 实测接地电阻（Ω） */
  measuredOhm: number
  /** 限值（Ω） */
  limitOhm: number
  /** 检测仪器与编号 */
  meter: string
  /** 检测日期 */
  measureDate: string
  state: ImportRowState
  /** 挂接 / 建档到的测点 id */
  pointId: string | null
  /** 处理说明（挂接对象、保护原因、失败原因） */
  message: string
  createdAt: number
  updatedAt: number
}

/** 批次粘贴文本解析出的一行 */
export interface BatchPasteRow {
  code: string
  deviceType: DeviceType
  location: string
  measuredOhm: number
  limitOhm: number
}

/** 行判重指纹：编号 + 设备类型 + 位置 + 实测 + 限值，同批次内唯一 */
export function rowFingerprint(row: {
  code: string
  deviceType: string
  location: string
  measuredOhm: number
  limitOhm: number
}): string {
  return [row.code, row.deviceType, row.location, row.measuredOhm, row.limitOhm].join('|')
}

/** 生成批次号：PC-YYYYMMDD-两位序号，避开已存在的批次号 */
export function makeBatchNo(existing: string[], date = new Date()): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const prefix = `PC-${ymd}-`
  const used = new Set(existing)
  let seq = 1
  while (used.has(`${prefix}${String(seq).padStart(2, '0')}`)) seq += 1
  return `${prefix}${String(seq).padStart(2, '0')}`
}

/**
 * 解析批次粘贴文本。
 * 新格式每行「测点编号,设备类型,位置,实测电阻[,限值]」；
 * 兼容旧格式「测点编号,位置,实测电阻[,限值]」（设备类型取批次默认类型）。
 * 逗号 / 制表符 / 分号均可作分隔。
 */
export function parseBatchPaste(
  text: string,
  defaultLimitOhm = 10,
  defaultDeviceType: DeviceType = '接地体'
): { rows: BatchPasteRow[]; errors: string[] } {
  const rows: BatchPasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「测点编号,位置,实测电阻」三列`)
      return
    }
    // 第二列是合法设备类型（或留空）时按新格式解析，否则按旧格式（无设备类型列）
    const typed = DEVICE_TYPES.includes(cells[1] as DeviceType)
    const blankType = cells[1] === '' && cells.length >= 4
    let deviceType = defaultDeviceType
    let locationCell: string
    let measuredCell: string
    let limitCell: string | undefined
    if (typed || blankType) {
      if (cells.length < 4) {
        errors.push(`第 ${index + 1} 行「${line}」含设备类型列时至少需要「编号,类型,位置,实测」四列`)
        return
      }
      if (typed) deviceType = cells[1] as DeviceType
      locationCell = cells[2]
      measuredCell = cells[3]
      limitCell = cells[4]
    } else {
      locationCell = cells[1]
      measuredCell = cells[2]
      limitCell = cells[3]
    }
    const measuredOhm = Number(measuredCell)
    if (!Number.isFinite(measuredOhm) || measuredOhm < 0) {
      errors.push(`第 ${index + 1} 行实测电阻应为非负数字`)
      return
    }
    const limitOhm = limitCell !== undefined && limitCell !== '' ? Number(limitCell) : defaultLimitOhm
    if (!Number.isFinite(limitOhm) || limitOhm <= 0) {
      errors.push(`第 ${index + 1} 行限值应为大于 0 的数字`)
      return
    }
    rows.push({
      code: cells[0],
      deviceType,
      location: locationCell,
      measuredOhm: Number(measuredOhm.toFixed(3)),
      limitOhm: Number(limitOhm.toFixed(3))
    })
  })
  return { rows, errors }
}
