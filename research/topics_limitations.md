##### 基于Electron开发跳转至其他应用 (0201196029906869654) [views=357 replies=1]
使用Electron框架，如何跳转至其他应用？

##### electron应用上如何读写文件？ (0202197197809736470) [views=422 replies=1]
在HarmonyOS electron上，应用如何对文件进行读写？

##### Harmony Electron如何实现窗口记忆持久化 (0203202924502783145) [views=156 replies=1]
Electron应用采用electron-window-state三方库做应用窗口的持久化，适配到HarmonyOS PC后，应用无法记忆窗口大小，重启后恢复到默认大小，如何实现窗口记忆持久化？

##### electron窗口在HarmonyOS和windows上的区别 (0202206298304178578) [views=385 replies=3]
HarmonyOS创建的electron窗口和windows创建的electron窗口有哪些区别？

##### HarmonyOS electron如何设置窗口样式 (0201195855903099500) [views=203 replies=1]
HarmonyOS electron可以从哪些方面修改窗口的样式？

##### HarmonyOS electron如何自定义标题栏 (0201194546421995334) [views=310 replies=0]
场景介绍
  标题栏是每一个PC应用都存在的场景，本示例实现在应用上自定义标题栏。
  本示例通过创建无边框隐藏标题栏窗口来隐藏系统默认标题栏，在html实现对标题栏的拖动区域和三键的自定义，同时通过Menu建立菜单，实现系统菜单栏的自定义。
  效果预览
  
  实现思路
    创建无边框和隐藏标题栏窗口，隐藏系统标题栏，方便之后自定义标题栏，具体代码如下：
   function createWindow() {
  tray = new Tray(path.join(__dirname, '../electron_white.png'));
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    // 创建无边框窗口
    frame: false,
    titleBarStyle: 'hidden',
    // WebPreferences配置
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile(path.join(__dirname, 'renderer/index.html'))
}

    在html中自定义标题栏和三键，通过加入-webkit-app-region：drag来修饰标题栏区域来实现拖拽效果，手动创建三键，通过IPC向主进程发送最小化、最大化和关闭窗口的消息，主进程调用win.minimize()、win.maximize()和win.close()来实现三键功能，具体代码如下：
   <!DOCTYPE html>
<html>
<head>
  <style>
    /* 自定义标题栏样式 */
    .title-bar {
      -webkit-app-region: drag;
      height: 40px;
      background: linear-gradient(90deg, #1e3c72, #2a5298);
      color: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 15px;
      user-select: none;
    }

    .window-title {
      font-size: 14px;
      font-weight: 500;
    }

    /* 窗口控制按钮 */
    .window-controls {
      display: flex;
      -webkit-app-region: no-drag;
    }

    .window-btn {
      width: 40px;
      height: 40px;
      border: none;
      background: transparent;
      color: white;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }

    .window-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .close-btn:hover {
      background: #e81123;
      color: white;
    }

    /* 自定义窗口阴影 */
    body {
      margin: 0;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
      border-radius: 8px;
      overflow: hidden;
    }

    /* 内容区域 */
    .content {
      height: calc(100vh - 40px);
      padding: 20px;
    }
  </style>
</head>
<body>
<!-- 自定义标题栏 -->
<div class="title-bar">
  <div class="window-title">我的应用</div>
  <div class="window-controls">
    <button class="window-btn" id="min-btn">−</button>
    <button class="window-btn" id="max-btn">□</button>
    <button class="window-btn close-btn" id="close-btn">×</button>
  </div>
</div>

<!-- 内容区域 -->
<div class="content">
  <h1>自定义窗口样式</h1>
  <p>这是一个自定义样式的 Electron 窗口</p>
</div>

<script>
  // 窗口控制逻辑
  const { ipcRenderer } = require('electron')

  document.getElementById('min-btn').addEventListener('click', () => {
    ipcRenderer.send('window-minimize')
  })

  document.getElementById('max-btn').addEventListener('click', () => {
    ipcRenderer.send('window-maximize')
  })

  document.getElementById('close-btn').addEventListener('click', () => {
    ipcRenderer.send('window-close')
  })
</script>
</body>
</html>

    创建带系统标题栏窗口，通过Menu实现系统菜单栏的自定义，具体代码如下：
   ipcMain.on('create-window', (event) => {

  const sysWin = new BrowserWindow({
    x: 100,
    y: 100,
    width: 800,
    height: 600
  })

  sysWin.setWindowButtonVisibility(true);
  // 替换成真实网址路径
  sysWin.loadURL('xx.xx.xx')

  // 创建应用菜单
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
})

  【常见FAQ】
 Q：系统三键如何设置显隐？
 A：HarmonyOS electron当前有三种窗口类型（主窗、子窗、悬浮窗），子窗和悬浮窗由于系统规格，无系统三键，具体参考：调整三键。主窗三键可通过对标其他平台的win.setWindowButtonVisibility(visible)接口来实现三键的显隐，该接口可在窗口调用接口win.loadURL(url[, options])或win.loadFile(filePath[, options])之前调用。win.setWindowButtonVisibility(visible)配合win.maximizable可以设置最大化键的单独显隐，最小化和关闭键的显隐跟随接口win.setWindowButtonVisibility(visible)的设置，具体显隐如下：
               最大化    最小化    关闭   
       win.setWindowButtonVisibility(true)和win.maximizable为true    显    显    显   
       win.setWindowButtonVisibility(true)和win.maximizable为false    隐    显    显   
       win.setWindowButtonVisibility(false)和win.maximizable为true    隐    隐    隐   
           win.setWindowButtonVisibility(false)和win.maximizable为false
        隐    隐    隐   
     说明
  搭建HarmonyOS electron开发环境运行该示例代码。
  约束与限制
    本示例支持API Version 20 Release及以上版本。
  本示例支持HarmonyOS 6.0.0 Release SDK及以上版本。
  本示例需要使用DevEco Studio 6.0.0 Release及以上版本进行编译运行。
   工程目录
  app
├──renderer            // 渲染进程模块
│  └──index.html       // 主窗口加载的页面
├──main.js             // 主进程
├──electron_white.png  // 应用图标
└──package.json        // 配置程序入口

  参考文档
  BrowserWindow
  ipcMain
  代码示例
  详情见 HarmonyOS electron如何自定义标题栏
