# 剑桥路考路线助手（Cambridge Driving Test Routes）

把 YouTube 上的 mock test 路线视频变成**可视化的路线 + 注意点**：限速、环岛走法、左转自行车道盲区、黄色网格、车道选择……
电脑上录入，手机上预习、导航。需求整理和分层计划见 [PLAN.md](PLAN.md)。

## 快速开始

```bash
npm start
```

- 路线编辑器（电脑）：<http://localhost:5173/editor.html>
- 查看端（手机界面，电脑上也能看）：<http://localhost:5173/>

只需要 Node.js，没有其他依赖。`node_modules` 只用来更新 Leaflet（`npm install && npm run vendor`）。

## 录入一条路线（推荐流程）

1. 编辑器里点 **新建**，粘贴 YouTube 链接。起点会自动放在考场（Brookmount Court）。
2. 播放视频，车辆出发时点 **设为出发时刻**。
3. 按 <kbd>W</kbd> 进入途经点模式。每到一个路口就暂停，在地图上点车辆**驶入的那条路**：
   - 路线会自动沿道路吸附；
   - 途经点会记下当前视频时间，之后地图上的橙色小车会跟着视频走，点路线也能跳到视频里对应的时刻。
4. 遇到注意点，按数字键选类型，再点地图放置：
   - <kbd>1</kbd> 限速、<kbd>2</kbd> 环岛、<kbd>3</kbd> 自行车道/盲区、<kbd>4</kbd> 黄色网格、<kbd>5</kbd> 车道/变道；
   - <kbd>6</kbd> 人行横道、<kbd>7</kbd> 路口观察、<kbd>8</kbd> 公交车道、<kbd>9</kbd> 危险、<kbd>0</kbd> 备注。
5. 加截图：
   - YouTube 视频：先点一次 **开启一键截图**（浏览器会请你选择共享"此标签页"），之后按 <kbd>C</kbd> 就截取播放器画面；
   - 或者用 Win+Shift+S 截图，再按 <kbd>Ctrl</kbd>+<kbd>V</kbd>；
   - 本地视频文件可以直接按 <kbd>C</kbd>。
6. 路线画完后点 **自动识别**。它会从 OpenStreetMap 补上：
   - 限速变化；
   - 环岛：第几出口、几点钟方向、走哪条道、何时打灯；
   - 斑马线 / 信号灯人行横道、STOP 线、减速带、左侧公交车道；
   - 左转前左侧有自行车道、巴士专用道路口、铁路道口。

   自动识别的点是虚线边框，在"待核对"里对照视频逐个点 **✓ 与视频一致**。删掉的自动点，下次识别时不会再出现。
7. 自动保存到 `app/data/routes/<id>.json`，截图保存在 `app/data/media/<id>/`。

快捷键完整列表：编辑器右上角的 **?**。

## 装到手机上（PWA，部署到 GitHub Pages）

1. 在 GitHub 上新建一个**公开**仓库，比如 `driving-route`，不要勾选自动生成 README。
2. 在项目目录推送：

   ```bash
   git remote add origin https://github.com/<你的用户名>/driving-route.git
   ```

   ```bash
   git push -u origin main
   ```

   第一次推送会弹出浏览器窗口，登录 GitHub。
3. 打开仓库的 **Settings → Pages**，把 Build and deployment 的 Source 选成 **GitHub Actions**。之后每次推送，都会自动跑测试、构建并发布，大约 1 分钟。
4. 手机 Chrome 打开 `https://<你的用户名>.github.io/driving-route/`，点页面上的"安装到手机"，或者 Chrome 菜单 →「安装应用 / 添加到主屏幕」。之后它就像 App 一样从桌面打开，没网也能用。
5. 把自己的路线传到手机：编辑器「导出 / 导入」→「导出全部路线」，把文件发到手机（微信文件传输、邮件、Google Drive 都行），在 App 首页点导入按钮。

隐私：GitHub 仓库和网站都是公开的。所以默认**不提交你自己的路线和截图**，只发布程序和示例路线；你的路线留在电脑上，通过路线包导入手机（见 [.gitignore](.gitignore)）。如果你不介意公开、想让路线随发布自动更新到手机，可以删掉 `.gitignore` 里对应的几行。注意截图来自别人的视频。

部署前想先在本机看看效果：运行 `npm run preview`，打开 <http://localhost:5174>，和发布后的网站完全一样（没有保存接口）。也可以用 `npm run build` 生成 `dist/`，上传到 Cloudflare Pages、Netlify 等其他托管。

| 其他方式 | 做法 | 说明 |
|---|---|---|
| 同一 Wi-Fi | 电脑运行 `npm run lan`，手机浏览器打开终端里显示的地址 | 手机只读。HTTP 下不能安装、不能定位。Windows 防火墙第一次会弹窗，选允许"专用网络" |
| APK | Capacitor 打包（L2 计划） | 本机目前没有 JDK 和 Android SDK |

## 练车时：定位与前方注意点

路线地图右上角的 **定位** 会：

- 显示你的位置（蓝点）；
- 在顶部提示"前方 640 m：环岛 第3出口"，点一下就打开详情；
- 屏幕保持常亮。

需要 HTTPS，所以要用部署后的网址。手机固定在支架上只看不碰；语音提醒是 L2 的下一步。

## 导航

查看端 → 路线 →「导航/导出」：

- **Google Maps**：Google 一个链接最多带 9 个途经点，所以自动把路线分成几段，每段一个按钮，点了直接打开 Google 地图导航。途经点放在每个路口后约 35 米处，引导 Google 走同一条路。
- **OsmAnd（GPX）**：可以严格沿轨迹导航，注意点作为航点，接近时语音播报。航点语言可以在设置里选中文或英文。
- **Google My Maps（KML）**：mymaps.google.com → 导入。之后在 Google 地图 App 的「已保存 → 地图」里能看到全部标注。

## 自动识别是怎么做的

- 路线吸附用 [OSRM](https://project-osrm.org/)（OSM 路网），沿途路段和节点的标签来自 [Overpass API](https://overpass-api.de/)。
- 环岛：
  - 拟合环岛圆心，按各条支路接入环岛的位置算出出口顺序和钟点方向；
  - 按 Highway Code Rule 186 给出车道和打灯建议：第一出口走左道打左灯；12 点钟以内一般走左道、不打灯；过了 12 点钟走右道、打右灯；经过前一个出口后改打左灯；
  - 有 turn:lanes 数据的路口会显示车道箭头。
- 限制：
  - 黄色网格（box junction）OSM 基本没有数据，需要手动标；
  - OSM 数据可能过时，例如施工、限速调整。**一切以现场标志为准。**

## 目录

```
app/                 整个目录就是可部署的静态网站
  index.html         查看端（手机优先）
  editor.html        编辑器（电脑）
  js/core/           纯逻辑：几何、路由、OSM 分析、环岛、导出（可在 Node 里测试）
  js/ui/ js/*.js     界面
  data/routes/       路线 JSON（index.json 由服务器自动生成）
  data/media/        截图
server/server.mjs    本地服务器：静态文件 + 保存路线/截图（零依赖）
scripts/make-demo.mjs  重新生成示例路线
tests/               单元测试：npm test
```

## 注意

- 开车时不要操作手机（英国法律禁止驾驶时手持使用手机）。练车时手机固定在支架上，只看不碰。
- DVSA 不公布考试路线，视频里的路线仅供参考。
- OSRM 演示服务器、Overpass、OSM 瓦片都是公共服务，只适合低频的个人使用。
- 规则编号仅供参考，以官方 [Highway Code](https://www.gov.uk/guidance/the-highway-code) 为准。
