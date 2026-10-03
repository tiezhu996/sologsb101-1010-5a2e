<script lang="ts">
  /**
   * 模块 6：/batches 批次对账与断点续传
   * 外场带回的同一批次接地电阻数据按「批次号 + 测点编号 + 设备类型」挂回原记录：
   * - 相同批次号重复导入不重复建档；
   * - 已确认判定不被后来的实测值覆盖（并列建档）；
   * - 同批次同测点多条并列保留；
   * - 写入失败保留检查点，重试从断点接着处理；
   * - 本页查看挂接结果与待处理项。
   */
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import {
    batchSummaries,
    importBatchRows,
    importRowList,
    pendingImportCount,
    removeBatch,
    resumeBatch,
    rowsOfBatch
  } from '$lib/stores/batchStore.ts'
  import { buildingList, deviceList } from '$lib/stores/buildingStore.ts'
  import { pointList } from '$lib/stores/pointStore.ts'
  import { makeBatchNo, parseBatchPaste } from '$lib/types/batch.ts'
  import type { BatchPasteRow, ImportRowState } from '$lib/types/batch.ts'
  import { DEVICE_TYPES } from '$lib/types/device.ts'
  import type { DeviceType } from '$lib/types/device.ts'
  import { suggestLimitOhm } from '$lib/utils/resistance.ts'

  const today = new Date().toISOString().slice(0, 10)

  let batchNo = $state('')
  let buildingId = $state('')
  let deviceType = $state<DeviceType>('接地体')
  let meter = $state('')
  let measureDate = $state(today)
  let sourceNote = $state('')
  let paste = $state('')
  let parseErrors = $state<string[]>([])
  let preview = $state<BatchPasteRow[]>([])
  let notice = $state('')
  let busy = $state(false)
  let expandedBatchId = $state<string | null>(null)
  let onlyPending = $state(false)

  // 批次号默认按当天日期生成并避开已有批次；建筑物默认取第一栋
  $effect(() => {
    if (batchNo === '') batchNo = makeBatchNo($batchSummaries.map((item) => item.batch.batchNo))
  })
  $effect(() => {
    if (buildingId === '' && $buildingList.length > 0) buildingId = $buildingList[0].id
  })

  const defaultLimit = $derived(
    suggestLimitOhm(
      $buildingList.find((item) => item.id === buildingId)?.protectionClass ?? '三类',
      deviceType
    )
  )

  const totals = $derived({
    batches: $batchSummaries.length,
    pending: $pendingImportCount,
    attached: $batchSummaries.reduce((sum, item) => sum + item.attached, 0),
    created: $batchSummaries.reduce((sum, item) => sum + item.created, 0),
    parallel: $batchSummaries.reduce((sum, item) => sum + item.parallel, 0)
  })

  /** 当前展开批次的明细行（受「只看待处理项」过滤） */
  const expandedRows = $derived(
    expandedBatchId === null
      ? []
      : rowsOfBatch(expandedBatchId, $importRowList).filter(
          (row) => !onlyPending || row.state === '待处理' || row.state === '失败'
        )
  )

  function buildingName(id: string): string {
    return $buildingList.find((item) => item.id === id)?.name ?? (id === '' ? '（跨建筑物）' : '未知建筑物')
  }

  function pointLabel(pointId: string | null): string {
    if (!pointId) return '—'
    const point = $pointList.find((item) => item.id === pointId)
    if (!point) return pointId
    const device = $deviceList.find((item) => item.id === point.deviceId)
    return `${point.code}（${device?.type ?? '未知装置'}）`
  }

  function stateTone(state: ImportRowState): string {
    if (state === '失败') return 'gb-danger'
    if (state === '待处理') return 'gb-warn'
    return ''
  }

  function runPreview(): void {
    const parsed = parseBatchPaste(paste, defaultLimit, deviceType)
    parseErrors = parsed.errors
    preview = parsed.rows
  }

  async function submitImport(): Promise<void> {
    if (!buildingId) {
      notice = '请选择批次数据归属的建筑物。'
      return
    }
    const parsed = parseBatchPaste(paste, defaultLimit, deviceType)
    parseErrors = parsed.errors
    preview = parsed.rows
    if (parsed.rows.length === 0) {
      notice = parsed.errors.length > 0 ? '存在解析错误，请修正后再导入。' : '请先粘贴外场数据。'
      return
    }
    busy = true
    try {
      const result = await importBatchRows({
        batchNo,
        buildingId,
        deviceType,
        sourceNote: sourceNote.trim(),
        meter: meter.trim(),
        measureDate,
        rows: parsed.rows
      })
      expandedBatchId = result.batchId
      const parts = [
        result.reused ? `复用已有批次（相同批次号不重复建档）` : `已建批次 ${batchNo}`,
        `新增 ${result.added} 行`,
        result.duplicated > 0 ? `跳过重复行 ${result.duplicated} 条` : '',
        result.failed > 0 ? `失败 ${result.failed} 行（断点已保留，可重试续传）` : '',
        result.pending > 0 ? `待处理 ${result.pending} 行` : ''
      ].filter(Boolean)
      notice = `${parts.join('，')}。`
      paste = ''
      preview = []
      parseErrors = []
      batchNo = ''
    } catch (err) {
      notice = `导入失败：${err instanceof Error ? err.message : '未知错误'}；已处理部分保留检查点，可重试续传。`
    } finally {
      busy = false
    }
  }

  async function retryBatch(id: string): Promise<void> {
    busy = true
    try {
      const result = await resumeBatch(id)
      notice =
        result.failed > 0 || result.pending > 0
          ? `重试完成：仍有 ${result.failed} 行失败、${result.pending} 行待处理，断点已保留。`
          : '重试完成：该批次全部行已处理完毕。'
    } catch (err) {
      notice = `重试失败：${err instanceof Error ? err.message : '未知错误'}`
    } finally {
      busy = false
    }
  }

  async function confirmRemoveBatch(id: string, no: string): Promise<void> {
    const ok = window.confirm(`删除批次「${no}」及其对账记录？已建档的测点档案会保留。`)
    if (!ok) return
    await removeBatch(id)
    if (expandedBatchId === id) expandedBatchId = null
    notice = `批次「${no}」的对账记录已删除。`
  }

  function toggleExpand(id: string): void {
    expandedBatchId = expandedBatchId === id ? null : id
  }
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">批次对账与断点续传</h2>
      <p class="gb-hint">
        外场数据按「批次号 + 测点编号 + 设备类型」挂回原记录：相同批次不重复建档，已确认判定不被覆盖，
        同测点多条并列保留；写入失败保留检查点，重试从断点接着处理。
      </p>
    </div>
  </div>

  {#if notice}
    <p class="gb-alert">{notice}</p>
  {/if}

  <div class="gb-stats-row">
    <StatBadge label="导入批次" value={totals.batches} suffix="批" tone="primary" />
    <StatBadge label="待处理项" value={totals.pending} suffix="行" tone={totals.pending > 0 ? 'warning' : 'success'} />
    <StatBadge label="累计挂接" value={totals.attached} suffix="行" tone="info" />
    <StatBadge label="累计建档" value={totals.created} suffix="行" tone="default" />
    <StatBadge label="并列保留" value={totals.parallel} suffix="行" tone="default" />
  </div>

  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>导入外场批次数据</h3>
      <span class="gb-hint">
        每行「测点编号,设备类型,位置,实测电阻[,限值]」；也兼容旧格式「编号,位置,实测[,限值]」（设备类型取下方默认类型）
      </span>
    </div>
    <div class="import-grid">
      <label class="gb-field">
        <span>批次号 *（相同批次号复用原批次）</span>
        <input bind:value={batchNo} maxlength="32" placeholder="如 PC-20261003-01" />
      </label>
      <label class="gb-field">
        <span>归属建筑物 *</span>
        <select bind:value={buildingId}>
          {#each $buildingList as building (building.id)}
            <option value={building.id}>{building.name}</option>
          {/each}
        </select>
      </label>
      <label class="gb-field">
        <span>默认设备类型</span>
        <select bind:value={deviceType}>
          {#each DEVICE_TYPES as type (type)}
            <option value={type}>{type}</option>
          {/each}
        </select>
      </label>
      <label class="gb-field">
        <span>检测仪器</span>
        <input bind:value={meter} maxlength="60" placeholder="如 ZC-8 接地电阻测试仪 / No.20230517" />
      </label>
      <label class="gb-field">
        <span>检测日期</span>
        <input type="date" bind:value={measureDate} />
      </label>
      <label class="gb-field">
        <span>来源说明</span>
        <input bind:value={sourceNote} maxlength="60" placeholder="如 外场一组 / 油库罐区复测" />
      </label>
    </div>
    <label class="gb-field paste-area">
      <span>粘贴外场数据（建议限值 {defaultLimit} Ω）</span>
      <textarea
        rows="6"
        bind:value={paste}
        placeholder="JD-OIL-05,接地体,罐区东侧测试井,3.8,4&#10;JD-OIL-06,接地体,罐区西侧测试井,5.1,4"
      ></textarea>
    </label>
    {#if parseErrors.length > 0}
      <div class="errors">
        {#each parseErrors as error, index (index)}
          <p class="gb-alert">{error}</p>
        {/each}
      </div>
    {/if}
    {#if preview.length > 0}
      <table class="gb-table">
        <thead>
          <tr>
            <th>编号</th><th>设备类型</th><th>位置</th>
            <th class="is-num">实测（Ω）</th><th class="is-num">限值（Ω）</th>
          </tr>
        </thead>
        <tbody>
          {#each preview as row, index (index)}
            <tr>
              <td class="gb-mono">{row.code}</td>
              <td><span class="gb-tag">{row.deviceType}</span></td>
              <td>{row.location}</td>
              <td class="is-num gb-mono">{row.measuredOhm}</td>
              <td class="is-num gb-mono">{row.limitOhm}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    <div class="import-actions">
      <button class="btn" type="button" onclick={runPreview}>解析预览</button>
      <button class="btn btn--primary" type="button" disabled={busy} onclick={submitImport}>
        导入并按批次对账
      </button>
    </div>
  </div>

  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>批次对账清单（{$batchSummaries.length} 批）</h3>
      <label class="gb-field inline">
        <span class="gb-hint">
          <input type="checkbox" bind:checked={onlyPending} /> 只看待处理项
        </span>
      </label>
    </div>

    {#if $batchSummaries.length === 0}
      <EmptyPanel
        title="还没有导入批次"
        description="粘贴外场带回的批次数据并导入，系统按批次号、测点编号与设备类型自动挂回原记录。"
        compact
      />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>建筑物</th>
            <th>状态</th>
            <th class="is-num">进度</th>
            <th class="is-num">挂接</th>
            <th class="is-num">建档</th>
            <th class="is-num">并列</th>
            <th class="is-num">待处理</th>
            <th>断点</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each $batchSummaries as item (item.batch.id)}
            {@const expandable = item.rows.length > 0}
            <tr class:is-bad={item.failed > 0}>
              <td>
                <div class="gb-mono">{item.batch.batchNo}</div>
                <div class="gb-hint">{item.batch.sourceNote || '—'}</div>
              </td>
              <td>{buildingName(item.batch.buildingId)}</td>
              <td>
                <span class="gb-tag">{item.batch.state}</span>
                {#if item.failed > 0}
                  <div class="gb-danger">失败 {item.failed} 行</div>
                {/if}
              </td>
              <td class="is-num gb-mono">{item.batch.doneRows}/{item.batch.totalRows}</td>
              <td class="is-num gb-mono">{item.attached}</td>
              <td class="is-num gb-mono">{item.created}</td>
              <td class="is-num gb-mono">{item.parallel}</td>
              <td class="is-num gb-mono">{item.pending + item.failed}</td>
              <td class="gb-mono">
                {#if item.pending + item.failed > 0}
                  第 {item.batch.cursor} 行
                {:else}
                  —
                {/if}
              </td>
              <td class="row-actions">
                {#if expandable}
                  <button class="btn btn--small" type="button" onclick={() => toggleExpand(item.batch.id)}>
                    {expandedBatchId === item.batch.id ? '收起' : '挂接结果'}
                  </button>
                {/if}
                {#if item.pending + item.failed > 0}
                  <button
                    class="btn btn--primary btn--small"
                    type="button"
                    disabled={busy}
                    onclick={() => retryBatch(item.batch.id)}
                  >
                    断点重试
                  </button>
                {/if}
                <button
                  class="btn btn--danger btn--small"
                  type="button"
                  onclick={() => confirmRemoveBatch(item.batch.id, item.batch.batchNo)}
                >
                  删除
                </button>
              </td>
            </tr>
            {#if expandedBatchId === item.batch.id}
              <tr class="detail-row">
                <td colspan="10">
                  {#if expandedRows.length === 0}
                    <p class="gb-hint">没有符合条件的导入行。</p>
                  {:else}
                    <table class="gb-table">
                      <thead>
                        <tr>
                          <th class="is-num">行号</th>
                          <th>测点编号</th>
                          <th>设备类型</th>
                          <th>位置</th>
                          <th class="is-num">实测（Ω）</th>
                          <th class="is-num">限值（Ω）</th>
                          <th>状态</th>
                          <th>挂接测点</th>
                          <th>处理说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each expandedRows as row (row.id)}
                          <tr class:is-bad={row.state === '失败'}>
                            <td class="is-num gb-mono">{row.rowIndex}</td>
                            <td class="gb-mono">{row.code}</td>
                            <td><span class="gb-tag">{row.deviceType}</span></td>
                            <td class="gb-hint">{row.location}</td>
                            <td class="is-num gb-mono">{row.measuredOhm}</td>
                            <td class="is-num gb-mono">{row.limitOhm}</td>
                            <td><span class={stateTone(row.state)}>{row.state}</span></td>
                            <td class="gb-hint">{pointLabel(row.pointId)}</td>
                            <td class="gb-hint">{row.message || '—'}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <p class="gb-hint">
    旧数据说明：结构升级前没有批次来源的测点已按兼容规则回填到「初始批次（INIT-LEGACY）」，原有测点、判定与整改记录照旧可查。
  </p>
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page__head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .page__title {
    margin: 0 0 4px;
    font-size: 19px;
    color: #1d3557;
  }

  .import-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }

  .paste-area {
    margin-bottom: 12px;
  }

  .import-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .gb-field.inline {
    min-width: 120px;
  }

  .gb-warn {
    color: #d68910;
    font-weight: 600;
  }

  .errors {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 160px;
    overflow: auto;
    margin-bottom: 12px;
  }

  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  tr.is-bad td {
    background: #fff6f4;
  }

  tr.detail-row > td {
    background: #f7fafc;
    padding: 12px 16px;
  }
</style>
