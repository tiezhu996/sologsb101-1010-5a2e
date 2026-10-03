/**
 * 测点 store：维护测点集合、接地电阻录入草稿与装置筛选。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅。
 *
 * 依赖方向（单向）：pointStore → utils/db、types/*、utils/resistance、buildingStore。
 * 装置维度的测点统计（同时依赖两个 store）已下沉到 stores/pointStats.ts，避免循环依赖。
 */
import { derived, get, writable } from 'svelte/store'
import { db, watchTable } from '$lib/utils/db'
import type { Point, PointDraft } from '$lib/types/point'
import { createEmptyPointDraft } from '$lib/types/point'
import { LEGACY_BATCH_NO } from '$lib/types/batch'
import { deviceList } from '$lib/stores/buildingStore'
import { isQualified, limitRatio } from '$lib/utils/resistance'

/** 已由检测人确认判定的测点：其实测值/限值不允许再被改写 */
export class ProtectedPointError extends Error {
  constructor(code: string) {
    super(`测点「${code}」的判定已经检测人确认，实测值与限值已锁定；新读数请按批次并列导入，不会覆盖已确认结论。`)
    this.name = 'ProtectedPointError'
  }
}

/** 响应式测点集合 */
export const pointList = writable<Point[]>([])
export const pointReady = writable(false)

/** 电阻录入草稿（跨页面保留）与批量粘贴文本 */
export const pointDraft = writable<PointDraft>(createEmptyPointDraft())
export const pasteText = writable<string>('')
/** 装置筛选：当前查看的装置 id（null 表示全部） */
export const activeDeviceId = writable<string | null>(null)

watchTable<Point>(() => db.points).subscribe((rows) => {
  pointList.set(rows)
  pointReady.set(true)
})

/** 按装置取测点（按测点编号排序） */
export function pointsOfDevice(deviceId: string | null | undefined): Point[] {
  if (!deviceId) return []
  return get(pointList)
    .filter((point) => point.deviceId === deviceId)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

/** 当前装置筛选下的测点 */
export const activePoints = derived([pointList, activeDeviceId], ([$points, $deviceId]) => {
  if ($deviceId === null) return [...$points].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  return $points
    .filter((point) => point.deviceId === $deviceId)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
})

/** 测点行：附带装置类型与合格标记，供测点录入页表格展示 */
export const pointRows = derived([pointList, deviceList], ([$points, $devices]) =>
  $points
    .map((point) => {
      const device = $devices.find((item) => item.id === point.deviceId)
      return {
        point,
        device,
        deviceType: device?.type ?? '未知装置',
        qualified: isQualified(point.measuredOhm, point.limitOhm),
        ratio: limitRatio(point.measuredOhm, point.limitOhm)
      }
    })
    .sort((a, b) => b.ratio - a.ratio)
)

/** 查询测点的判定是否已确认（实测值/限值因此锁定） */
export async function isPointConfirmed(pointId: string): Promise<boolean> {
  const verdict = await db.verdicts.where('pointId').equals(pointId).first()
  return Boolean(verdict?.confirmed)
}

/**
 * 已确认判定的测点 id 集合（锁定标记）。
 * 直接经 watchTable 订阅 verdicts，避免 import rectifyStore 形成
 * rectifyStore → pointStore → rectifyStore 的 ES 模块循环依赖（TDZ 白屏）。
 */
import type { Verdict } from '$lib/types/verdict'
const verdictsForPoints = writable<Verdict[]>([])
watchTable<Verdict>(() => db.verdicts).subscribe((rows) => {
  verdictsForPoints.set(rows)
})
export const confirmedPointIds = derived(verdictsForPoints, ($verdicts) => {
  const ids = new Set<string>()
  $verdicts.forEach((verdict) => {
    if (verdict.confirmed) ids.add(verdict.pointId)
  })
  return ids
})

export function resetPointDraft(limitOhm = 10): void {
  pointDraft.set(createEmptyPointDraft(limitOhm))
}

export function setActiveDevice(deviceId: string | null): void {
  activeDeviceId.set(deviceId)
}

/* ------------------------------- 测点 ------------------------------- */

export async function createPoint(
  deviceId: string,
  payload: Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'readingOrdinal'> & {
    readingOrdinal?: number
  }
): Promise<Point> {
  const now = Date.now()
  const row: Point = {
    ...payload,
    deviceId,
    batchNo: payload.batchNo || LEGACY_BATCH_NO,
    readingOrdinal: payload.readingOrdinal ?? 1,
    id: `pnt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now
  }
  await db.points.put(row)
  return row
}

/**
 * 编辑测点：若测点存在已确认判定，则实测电阻与限值锁定（拒绝覆盖），
 * 位置 / 仪器等非判定字段仍可修改。
 */
export async function updatePoint(id: string, patch: Partial<Point>): Promise<void> {
  if (patch.measuredOhm !== undefined || patch.limitOhm !== undefined) {
    const confirmed = await isPointConfirmed(id)
    if (confirmed) {
      const point = await db.points.get(id)
      throw new ProtectedPointError(point?.code ?? id)
    }
  }
  await db.points.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除测点：同时删除其判定记录；批次读数回到待人工处理（留痕不丢，可重新挂接） */
export async function removePoint(id: string): Promise<void> {
  await db.transaction('rw', [db.points, db.verdicts, db.readings], async () => {
    await db.verdicts.where('pointId').equals(id).delete()
    await db.points.delete(id)
    await db.readings.where('pointId').equals(id).modify((reading) => {
      reading.status = 'pending'
      reading.pointId = null
      reading.deviceId = null
      reading.reason = '原挂接测点已删除，请重新指派装置'
      reading.updatedAt = Date.now()
    })
  })
}

/**
 * 批量改写某装置全部测点的实测电阻；已确认判定的测点自动跳过、不改写。
 * @returns 改写条数与因判定已确认而跳过的条数
 */
export async function bulkSetMeasured(
  deviceId: string,
  measuredOhm: number
): Promise<{ updated: number; skipped: number; skippedCodes: string[] }> {
  const now = Date.now()
  const [points, verdicts] = await Promise.all([
    db.points.where('deviceId').equals(deviceId).toArray(),
    db.verdicts.toArray()
  ])
  const confirmedIds = new Set(verdicts.filter((verdict) => verdict.confirmed).map((verdict) => verdict.pointId))
  const skippedCodes = points.filter((point) => confirmedIds.has(point.id)).map((point) => point.code)
  const targets = points.filter((point) => !confirmedIds.has(point.id))
  if (targets.length > 0) {
    await db.points
      .where('id')
      .anyOf(targets.map((point) => point.id))
      .modify((point) => {
        point.measuredOhm = measuredOhm
        point.updatedAt = now
      })
  }
  return { updated: targets.length, skipped: skippedCodes.length, skippedCodes }
}
