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
| 路由 | 自建 history 路由（`utils/location.ts`） | 真实路径 `/buildings`、`/devices`、`/points`、`/batches`、`/verdicts`、`/backup` |
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
| `/points` | 接地电阻测点录入 | Point、Device | 逐点录实测电阻与限值、批量改写、批量粘贴导入（`编号,位置,实测[,限值]`） |
| `/batches` | 批次对账与断点续传 | ImportBatch、ImportRow、Point、Verdict | 外场批次数据按「批次号+测点编号+设备类型」挂回原记录，相同批次不重复建档，已确认判定不被覆盖，同测点多条并列保留，失败断点重试，查看挂接结果与待处理项 |
| `/verdicts` | 合格判定与整改建议 | Verdict、Point、Rectify | 自动初判（实测 ≤ 限值）、检测人确认生效、批量改判、由不合格判定批量生成整改建议、整改状态机（待整改→已整改→已复检） |
| `/backup` | 检测结论与结构版本导出 | 全部模型 | 按建筑物出检测结论、全部测点判定一览、全量 JSON 导入导出（覆盖 / 追加两种模式）、清空重建演示数据 |

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
        │   ├── stores/           # buildingStore / pointStore / rectifyStore / batchStore
        │   ├── components/common/# QualifyTag / FilterBar / StatBadge / EmptyPanel
        │   ├── hooks/            # useIdbTable / useQualifyRate
        │   └── utils/            # resistance.ts / db.ts / export.ts / query.ts
        └── routes/
            ├── index.ts          # 路由表（真实路径 → 页面组件映射）
            ├── BuildingList.svelte
            ├── DeviceList.svelte
            ├── PointEntry.svelte
            ├── BatchBoard.svelte
            ├── VerdictBoard.svelte
            └── BackupView.svelte
```

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
- **数据表**：`buildings`（建筑物）、`devices`（防雷装置）、`points`（接地电阻测点）、`verdicts`（合格判定）、`rectifies`（整改建议）、`batches`（导入批次）、`importRows`（批次导入行）。
- **升级迁移**：`db.version(1)` / `db.version(2)` 保留历史结构，`db.version(3).stores(...).upgrade(...)` 新增批次两表与测点批次索引，并按兼容规则回填：没有批次来源的旧测点统一归入「初始批次（INIT-LEGACY）」，旧判定回填判定当时的限值快照；原有测点、判定与整改记录内容保持不变、照旧可查。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **批次对账**：外场数据按「批次号 + 测点编号 + 设备类型」挂回原记录——批次号全站唯一，相同批次重复导入复用原批次、内容相同的行按指纹跳过，不会重复建档；已确认判定的测点实测值不被覆盖（新数据并列建档）；同一测点在同一批次出现多条时按 `seq` 并列保留，不自动取舍；判定记录保存 `limitOhm` 限值快照，已确认结论当时按哪份限值作出可随时追溯。
- **断点续传**：每个导入行的处理状态与批次游标（`cursor`）同事务提交；写入失败即中断并标记「部分失败」，重试同一批次时从断点接着处理「待处理 / 失败」行，已完成行不重跑。`/batches` 页可查看每行挂接结果与待处理项。
- **首屏播种**：`initDatabase()` 在 `buildings` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 栋建筑物 / 6 个防雷装置 / 10 个测点 / 10 条判定 / 整改建议），测点统一归入初始批次，其中既有合格样本也有超限样本，便于演示挂红、整改与结论导出。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Svelte store 自动刷新，页面用 `$store` 只读订阅。
- **判定规则**：实测电阻 ≤ 限值判合格；限值初始值按防雷类别与装置类型建议（一类/二类接地装置 4 Ω，其余 10 Ω），最终以设计文件与规范条款为准。
- **备份与恢复**：`/backup` 页可导出包含七张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，批次号加迁移后缀避免撞号）」；旧版不含批次表的备份文件可正常导入（按空数组兼容）。备份时间写入 `localStorage`，页脚与备份页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
