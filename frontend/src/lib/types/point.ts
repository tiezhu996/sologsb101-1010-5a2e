/** 测点：接地电阻实测点，逐个录入实测值与限值 */
export interface Point {
  id: string
  /** 所属防雷装置 */
  deviceId: string
  /** 测点编号，如 JD-01 */
  code: string
  /** 测点位置描述 */
  location: string
  /** 实测接地电阻（Ω） */
  measuredOhm: number
  /** 限值（Ω），按防雷类别与装置类型给出初始值 */
  limitOhm: number
  /** 检测仪器与编号 */
  meter: string
  /** 检测日期 */
  measureDate: string
  /** 来源批次号（旧数据回填为初始批次，见 types/batch.ts） */
  batchNo: string
  /** 同一测点多条并列读数时的序号（1 为首录主值，>1 为同批次并列读数） */
  readingOrdinal: number
  createdAt: number
  updatedAt: number
}

/** 测点录入草稿（批量粘贴与单条新增共用） */
export interface PointDraft {
  code: string
  location: string
  measuredOhm: number
  limitOhm: number
  meter: string
  measureDate: string
}

export function createEmptyPointDraft(limitOhm = 10, meter = '', measureDate = ''): PointDraft {
  return {
    code: '',
    location: '',
    measuredOhm: 0,
    limitOhm,
    meter,
    measureDate: measureDate || new Date().toISOString().slice(0, 10)
  }
}
