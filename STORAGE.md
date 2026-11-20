# 足迹数据存储

IndexedDB 库名为 `footprints`。库版本为 2，使用对象仓库 `data` 和主键 `footprints:snapshot`。快照结构为 `{ revision: number, values: Record<string, string> }`，业务字段是 JSON 字符串。

| 新键 | 旧键 | 内容 |
| --- | --- | --- |
| `footprints:records` | `footprints-v1` | 点亮的地区与足迹备注 |

地区记录可以包含 `attractions` 数组，保存通过搜索确认点亮的景点标记。同一地区可以保存多个标记。标记包含 `id`（带来源前缀的标识）、`name`（景点名）和 `point`（GCJ-02，经度在前）。地图展示内置景点（`catalog:`）和先前通过高德搜索点亮的标记（`amap:`、`poi:`）。内置景点的 WGS84 坐标在点亮前转换为 GCJ-02。旧 OpenStreetMap 标记仍保存在原记录和备份中，带有 `source: "osm"`。移除单个标记时保留地区足迹。删除地区足迹时同时移除记录内的景点标记。

## 迁移与备份

优先读取新快照。新快照不存在时，先从旧 IndexedDB 的 `snapshot` 迁移。没有旧快照时，才从同来源的 `localStorage` 读取表中的键。事务成功后只更新新键，旧键保留用于过渡。新版工具保存的数据以 IndexedDB 为准。迁移要求在原浏览器或 QuickOpen 的原 WebView 中打开同一站点。跨设备时使用工具页内的 JSON 导出与导入。

新版 QuickOpen 的整包备份（v4）包含本工具的 IndexedDB 数据，恢复到空库时可一并还原。目标已有不同记录时保留目标数据。旧版 QuickOpen 的 v3 备份只保存当时的 `localStorage`。

应用内 JSON 备份同时支持版本 1 和 2。包含景点标记时导出版本 2。合并到已有地区时保留本地日期和备注，并按标记 ID 补充缺少的景点。

移除兼容前，需确认仍在用的旧版数据都有可用的迁移路径。保留 JSON 备份的导入兼容。
