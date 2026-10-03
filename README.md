# sologsb101-1010 防雷装置检测与接地电阻台账

面向防雷检测机构的纯前端单页应用：对建筑物的接闪器、引下线与接地装置逐项登记，按测点录入接地电阻实测值并与限值比对判定合格与否，最后汇总出检测结论与整改建议。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22810**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22810）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Svelte 5（runes：`$state` / `$derived` / `$props` / `$effect`） | 页面组件使用 `lang="ts"` |
| 语言 | TypeScript 5.7 | 构建脚本执行 `svelte-check --tsconfig ./tsconfig.json` |
| 路由 | 自建 history 路由 + svelte-spa-router 5 | hash 路由，`/buildings`、`/devices`、`/points`、`/batches`、`/verdicts`、`/backup` |
| 样式 | Tailwind CSS 4（`@tailwindcss/vite`）+ 自定义组件类 | 主题变量走 `@theme` |
| 状态管理 | Svelte store（`writable` / `derived`） | `buildingStore`、`pointStore`、`rectifyStore`、`batchStore` |
| 持久化 | Dexie 4（IndexedDB，库名 `gblightprot`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/buildings` | 建筑物与防雷类别台账 | Building、Device、Point | 新建/编辑/删除建筑物，按用途与防雷类别筛选，卡片回显装置数、测点数、不合格数与合格率 |
| `/devices` | 接闪器/引下线/接地装置登记 | Device、Building、Point | 登记类型、材质、规格、数量与安装日期，按建筑物与类型筛选，展开查看该装置全部测点 |
| `/points` | 接地电阻测点录入 | Point、Device | 逐点录实测电阻与限值、批量改写（已确认测点自动跳过）；表格显示来源批次、并列序号与判定锁定标记 |
| `/batches` | 批次对账与恢复 | Batch、Reading、Point、Verdict | 外场批次数据导入（文件/粘贴）、按批次号+测点编号+设备类型挂回原记录、查看挂接结果与待处理项、人工指派装置、检查点断点重试 |
| `/verdicts` | 合格判定与整改建议 | Verdict、Point、Rectify | 自动初判（实测 ≤ 限值）、检测人确认生效（留存确认时限值快照）、批量改判、由不合格判定批量生成整改建议、整改状态机（待整改→已整改→已复检） |
| `/backup` | 检测结论与结构版本导出 | 全部模型 | 按建筑物出检测结论、全部测点判定一览、全量 JSON 导入导出（覆盖 / 追加两种模式，旧备份自动回填初始批次）、清空重建演示数据 |

> 深层 id 场景：本项目的列表与明细集中在同一组路由（建筑物 → 装置 → 测点 → 判定 → 结论），不存在 `/xxx/:id/yyy` 形式的层级深链；筛选条件通过 query 传递（例如 `/points?device=dev_oil_belt`），刷新后仍可复现当前视图。若 query 指向的装置已被删除，页面自动回落到全部测点并给出空态引导，不会白屏。

## 四、目录结构

```
sologsb101-1010/
├── README.md
├── docker-compose.yml            # name: gblightprot，不写 version
├── Dockerfile                    # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                    # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile                # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf                # 前端独立托管用
    ├── .dockerignore
    ├── package.json              # build = svelte-check && vite build
    ├── tsconfig.json
    ├── vite.config.js
    ├── svelte.config.js
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.js               # Svelte 5 mount 入口，并打开并播种数据库
        ├── App.svelte            # 顶部导航（link action）+ 页脚数据概览
        ├── app.css               # Tailwind 入口 + 主题变量 + 通用组件类
        ├── lib/
        │   ├── types/            # building / device / point / verdict / rectify / batch
        │   ├── stores/           # buildingStore / pointStore / rectifyStore / batchStore / pointStats
        │   ├── components/common/# QualifyTag / FilterBar / StatBadge / EmptyPanel
        │   ├── hooks/            # useIdbTable / useQualifyRate
        │   └── utils/            # resistance.ts / db.ts / export.ts / query.ts（批次引擎在 stores/batchStore.ts）
        └── routes/
            ├── index.ts          # 路由表（自建 history 路由的 route 映射）
            ├── nav.ts            # 顶部导航配置
            ├── BuildingList.svelte
            ├── DeviceList.svelte
            ├── PointEntry.svelte
            ├── BatchReconcile.svelte
            ├── VerdictBoard.svelte
            └── BackupView.svelte
```

> 批次对账的端到端逻辑验证脚本位于 `frontend/scripts/test-batch.ts`（node + fake-indexeddb + tsx，不纳入生产构建），覆盖批次幂等、确认判定保护、并列保留、人工指派、断点续跑与 v2→v3 旧数据迁移。

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22810
npm run build      # svelte-check 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gblightprot`，当前结构版本 `v3`。所有读写经 `frontend/src/lib/utils/db.ts` 与 hooks 封装，组件不直接触碰 Dexie 实例。
- **数据表**：`buildings`（建筑物）、`devices`（防雷装置）、`points`（接地电阻测点，含 `batchNo` 来源批次与 `readingOrdinal` 并列序号）、`verdicts`（合格判定，含确认时 `limitOhm` 快照）、`rectifies`（整改建议）、`batches`（批次对账档案，幂等、带 `checkpointIndex` 检查点）、`readings`（批次内逐条实测读数留痕，含挂接状态/动作/归属）。
- **批次对账规则**：
  - 导入按「批次号 + 测点编号 + 设备类型」挂回原记录：先挂同批次已挂读数对应的测点，再按编号+装置类型匹配既有测点，都没有时在唯一同类型装置下新建；匹配不到或归属歧义的读数进入「待处理」，页面人工指派装置后挂接。
  - **相同批次不重复建档**：批次号唯一，重复导入只追加新行；整行内容（编号/类型/实测/限值/位置）相同直接跳过并计数。
  - **已确认判定不覆盖**：测点判定已由检测人确认后，后来导入的不同实测值不改写测点主值与判定，而是在同一装置下并列新建测点（标 🔒 与 `#序号`）；判定记录留存确认当时所依据的限值快照，判定台可查"按哪份限值作出"。
  - **多条并列保留**：同一测点在同一批次出现多条读数时并列保留、不自动取舍；未确认测点的新实测值会刷新主值并重新初判（仍待确认）。
  - **检查点恢复**：每条读数独立事务提交并推进 `checkpointIndex`；写入失败立即中断，保留检查点与失败行原因，批次页「从断点重试」只处理剩余行，已处理行不重复。
- **升级迁移**：`db.version(1)` 保留初版结构，`version(2)` 补筛选索引，`version(3).stores(...).upgrade(...)` 增加批次表、测点批次字段与判定限值快照；无批次来源的旧测点/判定/整改**按兼容规则原样保留**并统一回填到「初始批次」（`初始批次` 档案 + `migrated-legacy` 读数留痕），台账、判定与整改照旧可查；调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `buildings` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 栋建筑物 / 6 个防雷装置 / 10 个测点（含 1 个同测点并列读数）/ 判定 / 2 条整改建议），并附 1 个外场批次（含 1 条待人工指派读数样本），既有合格样本也有超限样本，便于演示挂红、整改与结论导出。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Svelte store 自动刷新，页面用 `$store` 只读订阅。
- **判定规则**：实测电阻 ≤ 限值判合格；限值初始值按防雷类别与装置类型建议（一类/二类接地装置 4 Ω，其余 10 Ω），最终以设计文件与规范条款为准。
- **备份与恢复**：`/backup` 页可导出包含七张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，批次号追加 -导入 后缀）」；旧版备份（无批次字段）导入时按兼容规则自动回填初始批次；备份时间写入 `localStorage`，页脚与备份页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
