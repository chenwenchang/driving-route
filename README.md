# 剑桥路考路线助手（Cambridge Driving Test Routes）

把 YouTube 上的 mock test 路线视频变成**可视化的路线 + 注意点**：限速、环岛走法、左转自行车道盲区、黄色网格、车道选择……
电脑上录入，手机上预习、导航。需求整理和分层计划见 [PLAN.md](PLAN.md)。

**手机端在线地址：<https://chenwenchang.github.io/driving-route/>**。用手机 Chrome 打开，然后「安装应用」。每次推送到 main 分支，都会自动重新发布。

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
   - 左转前左侧有自行车道、巴士专用道路口、铁路道口；
   - 沿途的路口（用于语音里的 "next / second road on the left"）。

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

## 练车时：定位、英文考官语音

路线地图右上角有三个按钮：

- **定位**：
  - 显示你的位置（蓝点）；
  - 顶部提示"前方 640 m：环岛 第3出口"，点一下就打开详情；
  - 屏幕保持常亮。
- **语音**：打开英文考官语音（英式英语，模仿路考考官的说法）。
  - 开场先说 "Please follow the road ahead, unless traffic signs direct you otherwise..."；
  - 每个路口前大约 8 秒说指令，例如 "Take the second road on the left, please"、"At the end of the road, turn right, please"、"At the roundabout, take the third exit, please"；
  - 数 "next / second road" 时只算能开进去的公共道路，不算车道入口和停车场；
  - 每句话同时在屏幕上显示英文字幕和中文意思。
- **模拟**：在家预演。小车按限速沿路线开，你听考官指令、看位置，可以暂停、拖动、1×–8× 倍速。说话时会自动放慢，不会漏掉指令。

**视频里的原话**：从有字幕的 YouTube 视频录入的路线，会保存视频里导航（TomTom）和考官说的每一句话和时间：

- 车开到视频里说这句话的地方，就播报同一句话。例如 "After 300 yards, go right on the roundabout and take the third exit, A14, towards Newmarket"。
- 视频里停车的地方（靠边停车、侧方停车、倒车入库），模拟时也会停下来，等考官说完 "When you are ready, drive on" 再走。
- 导航和考官用两个不同的声音。设置里可以选这两个声音，也可以换回自动生成的考官指令。
- 视频时间按字幕对齐，地图上的小车和视频基本同步。

语音听起来太机器人时，换一个更自然的声音：

- Android：系统设置 →「文字转语音」→ Google → English (United Kingdom)，在里面挑一个声音。
- 电脑 Chrome：选 "Google UK English"。
- iPhone：设置 → 辅助功能 →「朗读内容」→「声音」→ 英语，下载带「增强」或「高级」的声音。

设置里可以切换两种模式：

| 模式 | 播报内容 |
|---|---|
| 模拟考试（默认） | 只有考官指令，和真实考试一样。途中会问一个 "Show me" 问题，最后说 "That's the end of your test"。 |
| 练习 | 考官指令 + 英文提示（提示前"叮"一声）：环岛走哪条道、要不要打灯，过了前一个出口时 "Signal left now"，还有限速变化、左转看盲区、斑马线、公交车道等。 |

使用说明：

- 定位需要 HTTPS，所以要用部署后的网址。
- 第一次点「语音」或「定位」时，手机才允许网页发声。
- 手机上要有英式英语语音：Android 在系统设置 →「文字转语音」里安装「英语（英国）」。设置页可以选声音、调语速、试听。
- 屏幕要保持亮着，App 也要在前台：网页切到后台后，定位和语音都会停。
- 手机固定在支架上，只听、只看，不要碰。

### 把指令改成视频里考官的原话

编辑器 →「指令」标签：

- 每条指令都能改成视频里考官的原话，留空就用自动生成的句子；
- 不需要的指令点喇叭图标静音。

标注编辑里还有「语音（英文）」一栏：

- 可以给这个点写一句英文提示；
- 勾选"这是考官说的话"之后，模拟考试模式也会播放。例如考官说 "Follow the signs for the city centre"。

「考试动作」类型的标注，默认会说 "Pull up on the left at the next safe place, please"。停稳之后，再说 "Move off when you're ready"。

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
  js/core/           纯逻辑：几何、路由、OSM 分析、环岛、考官语音（examiner.js）、导出（可在 Node 里测试）
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
