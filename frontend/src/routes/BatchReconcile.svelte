<script lang="ts">
  /**
   * 模块 3.5：/batches 批次对账与恢复
   * 外场批次数据导入：按「批次号 + 测点编号 + 设备类型」挂回原记录；
   * 相同批次重复导入只追加新行、不重复建档；写入失败保留检查点，可从断点重试；
   * 页面查看每个批次的挂接结果与待人工处理项；旧数据归入「初始批次」可查。
   */
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import { buildingList, deviceList } from '$lib/stores/buildingStore.ts'
  import { pointList } from '$lib/stores/pointStore.ts'
  import {
    batchList,
    batchReady,
    batchSummaries,
    ignoreReading,
    pendingReadings,
    readingsOfBatch,
    removeBatch,
    reopenReading,
    resolveReadingAssign,
    resumableBatches,
    retryBatch,
    startBatchImport
  } from '$lib/stores/batchStore.ts'
  import { parseBatchRows, suggestBatchNo } from '$lib/types/batch.ts'
  import type { BatchInputRow } from '$lib/types/batch.ts'
  import { readFileText } from '$lib/utils/export.ts'

  let batchNo = $state(suggestBatchNo())
  let sourceName = $state('')
  let meter = $state('')
  let measureDate = $state(new Date().toISOString().slice(0, 10))
  let buildingId = $state<string>('')
  let paste = $state('')
  let parseErrors = $state<string[]>([])
  let preview = $state<BatchInputRow[]>([])
  let busy = $state(false)
  let notice = $state('')
  let expandedBatchId = $state<string | null>(null)
  let assignChoice = $state<Record<string, string>>({})
  let fileInput = $state<HTMLInputElement | null>(null)

  const totals = $derived({
    batches: $batchList.length,
    attached: $pointList.length,
    pending: $pendingReadings.length,
    resumable: $resumableBatches.length
  })

  const deviceLabel = (deviceId: string | null): string => {
    if (!deviceId) return '—'
    const device = $deviceList.find((item) => item.id === deviceId)
    if (!device) return '装置已删除'
    const building = $buildingList.find((item) => item.id === device.buildingId)
    return `${building?.name ?? '未知建筑物'} · ${device.type}${device.spec ? ` ${device.spec}` : ''}`
  }

  /** 指派下拉选项：按读数装置类型过滤 */
  function assignOptions(deviceType: string): Array<{ label: string; value: string }> {
    return $deviceList
      .filter((device) => device.type === deviceType)
      .map((device) => ({ label: deviceLabel(device.id), value: device.id }))
  }

  function pointLabel(pointId: string | null): string {
    if (!pointId) return '—'
    const point = $pointList.find((item) => item.id === pointId)
    return point ? `${point.code}${point.readingOrdinal > 1 ? ` #${point.readingOrdinal}` : ''}` : '测点已删除'
  }

  const STATUS_TEXT: Record<string, string> = {
    processing: '处理中',
    completed: '已处理完成',
    failed: '写入中断'
  }
  const READING_STATUS_TEXT: Record<string, string> = {
    queued: '排队中',
    attached: '已挂接',
    pending: '待处理',
    failed: '写入失败',
    ignored: '已忽略'
  }
  const ACTION_TEXT: Record<string, string> = {
    'matched-existing': '挂回既有测点',
    'created-point': '新建测点',
    'parallel-point': '并列保留',
    'protected-point': '判定已锁定·并列',
    'migrated-legacy': '初始批次回填',
    'manual-assign': '人工指派',
    none: '—'
  }

  function doPreview(): void {
    const parsed = parseBatchRows(paste, { meter: meter || undefined })
    parseErrors = parsed.errors
    preview = parsed.rows
  }

  async function handleFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await readFileText(file)
      paste = text
      sourceName = file.name
      doPreview()
      notice = `已读取文件 ${file.name}，请核对批次号后导入。`
    } catch {
      notice = '文件读取失败，请改用直接粘贴。'
    } finally {
      input.value = ''
    }
  }

  async function doImport(): Promise<void> {
    const parsed = parseBatchRows(paste, { meter: meter || undefined })
    parseErrors = parsed.errors
    preview = parsed.rows
    if (parsed.rows.length === 0) {
      notice = '没有可导入的有效行，请检查格式与错误提示。'
      return
    }
    if (!batchNo.trim()) {
      notice = '请填写批次号。'
      return
    }
    busy = true
    try {
      const result = await startBatchImport(parsed.rows, {
        batchNo: batchNo.trim(),
        sourceName: sourceName.trim() || '手工粘贴',
        meter: meter.trim(),
        measureDate,
        buildingId: buildingId || null
      })
      const p = result.process
      const head = result.reused
        ? `批次「${batchNo.trim()}」已存在，追加 ${result.inserted} 行（整行重复跳过 ${result.duplicated} 行），未重复建档。`
        : `新批次「${batchNo.trim()}」建档并导入 ${result.inserted} 行。`
      notice =
        p.failed > 0
          ? `${head}处理到第 ${p.stoppedAt + 1} 行写入失败已暂停，检查点已保留，可在下方从断点重试。（已挂接 ${p.attached}，待处理 ${p.pending}）`
          : `${head}已挂接 ${p.attached} 条（并列保留 ${p.parallel} 条），待人工指派 ${p.pending} 条。`
      if (p.failed === 0) {
        paste = ''
        preview = []
        parseErrors = []
      }
    } catch (error) {
      notice = `导入失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      busy = false
    }
  }

  async function doRetry(batchId: string): Promise<void> {
    busy = true
    try {
      const p = await retryBatch(batchId)
      notice =
        p.failed > 0
          ? `从断点重试后仍在第 ${p.stoppedAt + 1} 行失败，检查点继续保留：${p.error}`
          : `批次已从断点续跑完成：挂接 ${p.attached} 条，待人工指派 ${p.pending} 条。`
    } finally {
      busy = false
    }
  }

  async function doAssign(readingId: string): Promise<void> {
    const deviceId = assignChoice[readingId]
    if (!deviceId) {
      notice = '请先选择归属装置再确认指派。'
      return
    }
    busy = true
    try {
      await resolveReadingAssign(readingId, deviceId)
      notice = '读数已挂接到所选装置；若原测点判定已确认，将并列保留不改写。'
      delete assignChoice[readingId]
    } catch (error) {
      notice = `指派失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      busy = false
    }
  }

  async function doIgnore(readingId: string): Promise<void> {
    await ignoreReading(readingId)
    notice = '该读数已标记为忽略并留痕，可在批次明细中重新打开。'
  }

  async function doReopen(readingId: string): Promise<void> {
    await reopenReading(readingId)
    notice = '读数已重新打开为待处理。'
  }

  async function doRemove(batchId: string, batchNoText: string): Promise<void> {
    const ok = window.confirm(
      `删除批次「${batchNoText}」的对账档案与读数留痕？\n已挂接生成的测点、判定与整改建议会保留可查（初始批次不建议删除）。`
    )
    if (!ok) return
    await removeBatch(batchId, false)
    if (expandedBatchId === batchId) expandedBatchId = null
    notice = '批次对账档案已删除，测点与判定保留。'
  }

  function toggleDetail(batchId: string): void {
    expandedBatchId = expandedBatchId === batchId ? null : batchId
  }
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">批次对账与恢复</h2>
      <p class="gb-hint">
        外场带回的同一批次接地电阻数据按「批次号 + 测点编号 + 设备类型」挂回原记录；同批次重复导入不重复建档，
        已确认判定不被新实测值覆盖，同测点多条读数并列保留；写入中断保留检查点，可从断点重试。
      </p>
    </div>
  </div>

  {#if notice}
    <p class="gb-alert">{notice}</p>
  {/if}

  <div class="gb-stats-row">
    <StatBadge label="批次档案" value={totals.batches} suffix="个" tone="primary" />
    <StatBadge label="已挂接测点" value={totals.attached} suffix="点" tone="success" />
    <StatBadge
      label="待处理读数"
      value={totals.pending}
      suffix="条"
      tone={totals.pending > 0 ? 'warning' : 'success'}
    />
    <StatBadge
      label="未完成批次"
      value={totals.resumable}
      suffix="个"
      tone={totals.resumable > 0 ? 'danger' : 'default'}
    />
  </div>

  <!-- 未完成批次：断点重试入口 -->
  {#if $resumableBatches.length > 0}
    <div class="gb-panel resume-panel">
      <div class="gb-panel-title">
        <h3>未完成批次（检查点恢复）</h3>
        <span class="gb-hint">写入失败后已保留处理进度，重试同一批次从断点接着处理。</span>
      </div>
      {#each $resumableBatches as summary (summary.batch.id)}
        <div class="resume-row">
          <div>
            <strong class="gb-mono">{summary.batch.batchNo}</strong>
            <span class="gb-tag">{STATUS_TEXT[summary.batch.status]}</span>
            <span class="gb-hint">
              断点 {summary.batch.checkpointIndex}/{summary.batch.totalRows} · {summary.batch.lastError || '有待处理行'}
            </span>
          </div>
          <button class="btn btn--primary btn--small" type="button" disabled={busy} onclick={() => doRetry(summary.batch.id)}>
            从断点重试
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- 导入面板 -->
  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>导入外场批次数据</h3>
      <span class="gb-hint">每行：测点编号,设备类型,实测电阻[,限值[,位置[,仪器]]]；批次号在下方统一指定。</span>
    </div>
    <div class="import-grid">
      <label class="gb-field">
        <span>批次号 *（相同批次重复导入只追加）</span>
        <input bind:value={batchNo} placeholder="如 PC-20261003-01" maxlength="40" />
      </label>
      <label class="gb-field">
        <span>检测日期</span>
        <input type="date" bind:value={measureDate} />
      </label>
      <label class="gb-field">
        <span>挂接建筑物范围</span>
        <select bind:value={buildingId}>
          <option value="">全部建筑物</option>
          {#each $buildingList as building (building.id)}
            <option value={building.id}>{building.name}</option>
          {/each}
        </select>
      </label>
      <label class="gb-field">
        <span>检测仪器</span>
        <input bind:value={meter} placeholder="如 ZC-8 / No.20230517" maxlength="60" />
      </label>
      <label class="gb-field">
        <span>来源说明 / 文件名</span>
        <input bind:value={sourceName} placeholder="如 临港油库外场手记.csv" maxlength="80" />
      </label>
      <label class="gb-field">
        <span>选择文本文件（.csv / .txt）</span>
        <input type="file" accept=".csv,.txt,text/plain,text/csv" bind:this={fileInput} onchange={handleFile} />
      </label>
    </div>
    <label class="gb-field">
      <span>批量粘贴</span>
      <textarea
        rows="6"
        bind:value={paste}
        placeholder={'JD-OIL-01,接闪带,3.2,10,屋面西北角引下点\nJD-OIL-05,接地体,3.9,4,罐区东侧测试井'}
      ></textarea>
    </label>
    <div class="import-actions">
      <button class="btn" type="button" onclick={doPreview}>解析预览</button>
      <button class="btn btn--primary" type="button" disabled={busy} onclick={doImport}>
        按批次挂接导入
      </button>
      <span class="gb-hint">设备类型可写 接闪带/避雷带、接闪杆/避雷针、引下线、接地体/接地极 等手记别名。</span>
    </div>

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
          <tr><th>测点编号</th><th>设备类型</th><th class="is-num">实测（Ω）</th><th class="is-num">限值（Ω）</th><th>位置</th></tr>
        </thead>
        <tbody>
          {#each preview as row, index (index)}
            <tr>
              <td class="gb-mono">{row.code}</td>
              <td><span class="gb-tag">{row.deviceType}</span></td>
              <td class="is-num gb-mono">{row.measuredOhm}</td>
              <td class="is-num gb-mono">{row.limitOhm ?? '按装置建议'}</td>
              <td class="gb-hint">{row.location}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <!-- 待处理项 -->
  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>待处理读数（{$pendingReadings.length} 条）</h3>
      <span class="gb-hint">自动挂接找不到唯一归属装置或写入失败的读数，在此人工指派装置；读数始终留痕。</span>
    </div>
    {#if $pendingReadings.length === 0}
      <EmptyPanel title="没有待处理读数" description="所有批次读数均已挂接或忽略。新导入无法自动归属的读数会出现在这里。" compact />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>批次</th>
            <th>测点编号</th>
            <th>设备类型</th>
            <th class="is-num">实测（Ω）</th>
            <th class="is-num">限值（Ω）</th>
            <th>位置 / 原因</th>
            <th>指派归属装置</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each $pendingReadings as reading (reading.id)}
            <tr class:is-bad={reading.status === 'failed'}>
              <td class="gb-mono">{reading.batchNo}</td>
              <td class="gb-mono">{reading.code}</td>
              <td><span class="gb-tag">{reading.deviceType}</span></td>
              <td class="is-num gb-mono">{reading.measuredOhm}</td>
              <td class="is-num gb-mono">{reading.limitOhm ?? '—'}</td>
              <td class="gb-hint">
                <div>{reading.location}</div>
                <div class="gb-danger">{reading.reason}</div>
              </td>
              <td>
                <select bind:value={assignChoice[reading.id]}>
                  <option value="">请选择{reading.deviceType}装置</option>
                  {#each assignOptions(reading.deviceType) as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              </td>
              <td class="row-actions">
                <button class="btn btn--primary btn--small" type="button" disabled={busy} onclick={() => doAssign(reading.id)}>
                  指派挂接
                </button>
                <button class="btn btn--small" type="button" onclick={() => doIgnore(reading.id)}>忽略</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <!-- 批次档案 -->
  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>批次档案与挂接结果（{$batchList.length} 个）</h3>
      <span class="gb-hint">初始批次为无批次来源的历史数据兼容回填，原有测点、判定与整改照旧可查。</span>
    </div>
    {#if !$batchReady}
      <p class="gb-hint">正在载入批次档案…</p>
    {:else if $batchSummaries.length === 0}
      <EmptyPanel title="还没有批次档案" description="在上方粘贴或选择外场数据文件，填写批次号后导入，即可在此对账。" compact />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>批次号 / 来源</th>
            <th>状态</th>
            <th class="is-num">总读数</th>
            <th class="is-num">已挂接</th>
            <th class="is-num">待处理</th>
            <th class="is-num">重复跳过</th>
            <th>检查点</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each $batchSummaries as summary (summary.batch.id)}
            <tr>
              <td>
                <div class="gb-mono"><strong>{summary.batch.batchNo}</strong></div>
                <div class="gb-hint">
                  {summary.batch.sourceName || '—'} · {summary.batch.measureDate || '日期未填'}
                  {summary.batch.note ? ` · ${summary.batch.note}` : ''}
                </div>
              </td>
              <td>
                <span class="gb-tag">{STATUS_TEXT[summary.batch.status]}</span>
                {#if summary.pending > 0}<div class="gb-danger">待处理 {summary.pending}</div>{/if}
              </td>
              <td class="is-num gb-mono">{summary.total}</td>
              <td class="is-num gb-mono">{summary.attached}</td>
              <td class="is-num gb-mono">{summary.pending + summary.failed}</td>
              <td class="is-num gb-mono">{summary.batch.duplicatedRows}</td>
              <td class="gb-mono">
                {summary.batch.checkpointIndex}/{summary.batch.totalRows}
                <div class="progress"><span style={`width:${summary.progressPct}%`}></span></div>
              </td>
              <td class="row-actions">
                <button class="btn btn--small" type="button" onclick={() => toggleDetail(summary.batch.id)}>
                  {expandedBatchId === summary.batch.id ? '收起明细' : '挂接明细'}
                </button>
                {#if summary.batch.status !== 'completed' || summary.failed > 0 || summary.queued > 0}
                  <button class="btn btn--primary btn--small" type="button" disabled={busy} onclick={() => doRetry(summary.batch.id)}>
                    断点重试
                  </button>
                {/if}
                <button class="btn btn--danger btn--small" type="button" onclick={() => doRemove(summary.batch.id, summary.batch.batchNo)}>
                  删档案
                </button>
              </td>
            </tr>
            {#if expandedBatchId === summary.batch.id}
              <tr class="detail-row">
                <td colspan="8">
                  <table class="gb-table sub-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>测点编号</th>
                        <th>设备类型</th>
                        <th class="is-num">实测</th>
                        <th class="is-num">限值</th>
                        <th>状态</th>
                        <th>动作</th>
                        <th>挂接测点 / 装置</th>
                        <th>说明</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each readingsOfBatch(summary.batch.id) as reading (reading.id)}
                        <tr class:is-bad={reading.status === 'failed'}>
                          <td class="gb-mono">{reading.rowOrder + 1}</td>
                          <td class="gb-mono">{reading.code}</td>
                          <td><span class="gb-tag">{reading.deviceType}</span></td>
                          <td class="is-num gb-mono">{reading.measuredOhm}</td>
                          <td class="is-num gb-mono">{reading.limitOhm ?? '—'}</td>
                          <td>{READING_STATUS_TEXT[reading.status]}</td>
                          <td class="gb-hint">{ACTION_TEXT[reading.action]}</td>
                          <td class="gb-hint">
                            <div>{pointLabel(reading.pointId)}</div>
                            <div>{deviceLabel(reading.deviceId)}</div>
                          </td>
                          <td class="gb-hint">{reading.reason}</td>
                          <td>
                            {#if reading.status === 'ignored'}
                              <button class="btn btn--small" type="button" onclick={() => doReopen(reading.id)}>重新打开</button>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page__title {
    margin: 0 0 4px;
    font-size: 19px;
    color: #1d3557;
  }

  .import-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }

  .import-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 10px 0;
  }

  .errors {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 160px;
    overflow: auto;
  }

  .resume-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 4px;
    border-top: 1px dashed #c9d5e0;
  }

  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  tr.is-bad td {
    background: #fff6f4;
  }

  .detail-row td {
    background: #f8fbfd;
    padding: 8px 12px;
  }

  .sub-table {
    font-size: 12px;
  }

  .progress {
    width: 90px;
    height: 5px;
    border-radius: 999px;
    background: #eef2f6;
    overflow: hidden;
    margin-top: 3px;
  }

  .progress span {
    display: block;
    height: 100%;
    background: #457b9d;
  }
</style>
