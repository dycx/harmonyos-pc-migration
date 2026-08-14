# Electron HNP打包与fork指导文档

[返回主文档](../../README.md)

## 目录

- [前言-背景陈述](#前言-背景陈述)
- [通过hnp规避系统限制，实现fork](#通过hnp规避系统限制实现fork)
- [编写可执行二进制：hello](#补充---编写一个可执行二进制hello)
- [构建HNP包](#2-构建hnp包)
- [集成到Electron内部](#3-集成到electron内部)
- [DevEco打包流水线修改](#4-deveco打包流水线修改)
- [electron的demo](#5-electron的demo)
- [Electron源码修改](#6-electron源码修改)

---

# 前言-背景陈述

## 1. 能否直接调用可执行二进制文件？

**不能**，PC 25镜像及以后对应用可执行二进制在内核层进行权限管控，没有签名的二进制会被xpm拦截，具体如下

```
{ "event_type": "get signature info failed", "code_type": "ELF", "pid": 10041, "comm": "electron", "filename": "/data/storage/el1/bundle/entry/resources/resfile/electron", "vm_prot": 5,"vm_pgoff": 0, "vm_size": 16384, "p_id_type": 0, "p_ownerid": "0", "f_id_type": 1, "f_ownerid": "0", "timestamp": "1719633118"
​
```

**注: echo 0 > /proc/sys/kernel/xpm/xpm_mode**可关闭XPM，仅供调试

## 2. 什么解决方案？

HNP方案为系统专门针对应用内需要调用二进制文件所提供的方案，用于对应用内可执行二进制进行签名，避免被xpm拦截。
官方HNP编译参考可见：https://gitee.com/openharmony/startup_appspawn/blob/master/service/hnp/pack/README_zh.md

# 一、Electron内调用可执行二进制完整案例（fork为例）

果需要使用fork等方法拉起子进程，需要用到electron二进制文件进行拉起，

## 1 构建HNP包

### 1.1 HNP包说明

当应用的HAP工程内存在hnp设置时，会在打包生成的HAP包中存在hnp目录，当应用HAP包安装到系统时，自动将HNP目录下的内容释放到系统目录中，针对公有和私有的hnp目录，其目录如下

* 公有hnp目录在沙盒中的路径：/data/service/hnp，对应物理路径/data/app/el1/bundle/userid/hnppublic/,可以通过环境变量HNP_PRIVATE_HOME获取,该环节变量已添加到环境变量path中
* 私有hnp目录在沙盒中的路径：/data/app，对应物理路径/data/app/el1/bundle/userid/hnp/bundlename/,可以通过环境变量HNP_PUBLIC_HOME获取,该环节变量已添加到环境变量path中

如何查看当前应用沙箱内路径是什么呢，需要进入沙箱视角，进入命令如下：

```
nsenter -t 进程号 -m sh
```

### 1.2 构建HNP包

**hnp目录需要自行创建！** 
hnp目录结构如下：（这里的例子里把所有electron的内容都放置到了electron目录下，可以简化，放electron二进制即可）

```
hnp
├── bin
│   └── electron
│       └── locales (文件夹)
│       └── chrome_100_percent.pak
│       └── chrome_200_percent.pak
│       └── electron (关键)
│       └── icudtl.dat
│       └── resources.pak
│       └── snapshot_blob.bin
│       └── v8_context_snapshot.bin
└── hnp.json
```
electron中的文件可从自己工程的`web_engine/src/main/resources/resfile/resources`目录下取。
`hnp.json`中的内容如下：

```
{
    "type":"hnp-config",
    "name":"electron",
    "version":"1.0",
    "install":{
        "links":[
            {
                "source":"/bin/electron",
                "target":"electron"
            }
        ]
    }
}
```

在DevEco的安装目录`xxx\Huawei\DevEcoStudio\sdk\default\openharmony\toolchains`中，可以找到用于打包`hnpcli.exe`的可执行程序，在此目录下执行如下命令即可完成打包：

```
hnpcli pack -i 实际路径/hnp -o hnp包目标路径 -n electron -v 1.0

更多参数可参考：https://gitee.com/openharmony/startup_appspawn/blob/master/service/hnp/pack/README_zh.md
```

最终会生成`electron.hnp`文件。(执行hnpcli命令后注意查看信息，可能会出现打包命令执行error的情况)

![](./res/image.png)

## 2 集成到Electron内部
前面的准备都已完成，但想要在electron工程中正常使用hnp包，还需要添加一些配置~
### 2.1 配置修改

`ohos_hap\electron\src\main\module.json5`里面在module内加上hnp相关配置

![](./res/1772006424195_image.png)

```
"hnpPackages": [
  {
    "package": "electron.hnp",
    "type": "private"
  }
]
```

### 2.2 新增目录

在`ohos_hap`目录下，新增`hnp/arm64-v8a`目录，并放置上述打好的`electron.hnp`包

![](./res/1772006443261_image.png)

## 3. DevEco打包流水线修改

在 deveco-studio\tools\hvigor\hvigor-ohos-plugin\src\builder\inner-java-command-builder\packing-tool-options.js 增加以下代码

![](./res/1772006465993_image.png)

```
addHnpPath(t){return this.addFieldAndPath("--hnp-path",t);}
```

在 deveco-studio\tools\hvigor\hvigor-ohos-plugin\src\tasks\base\base-pack-hap-task.js 中添加，**注意变量名，有的文件中o和a位置替换了**

![](./res/1772006481290_image.png)

```
let hnpPath=path_1.default.resolve(process.cwd(),'hnp');if(fse.existsSync(hnpPath)){a.addHnpPath(hnpPath);}
```

![](./res/1772006495503_image.png)

更改完成后，重启DevEco

## 4. electron的demo
### 4.1使用fork拉起子进程
```javascript
// 使用fork拉起子进程
const { app, BrowserWindow, Tray, nativeImage, Menu } = require('electron');
const { fork } = require('child_process');
const path = require('path');


let mainWindow, tray;

function createWindow() {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'electron_white.png')));
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
    });
    //fork
    console.log('electron-demo start');
}

app.whenReady().then(() => {
    createWindow();
    console.log('electron-demo 即将开始fork！');
    const child = fork(path.join(__dirname,'child.js'));

    child.on('message',(message) => {
        console.log('electron-demo 主进程收到消息',message);
    });

    child.send({hello:'electron-demo from main process'});

    app.on('activate',() => {
        if(BrowserWindow.getAllWindow().length === 0) createWindow();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
});
```

```javascript
//child.js
process.on('message',(message) => {
    console.log('子进程收到消息:',message);

    process.send({hello:'electron-demo from child process',received:message});

    process.send({status:'electron-demo child process started'});
})

```
父子进程可正常通信，如下图：
![](./res/1772009141475_image.png)


## 5. 解释

上面的demo中，我们看到`main.js`里面的binPath设置了两个路径，为什么这么写呢，我们分别解释一下

1. 首先，HAP包安装以后，系统会自动在系统的`/data/app`目录下创建`electron.org/electron_1.0`目录，目录中的electron是hnp包的配置文件（`hnp.json`）中配置的`name`，`1.0`是在此文件中配置的`version`，并将hnp包中的文件目录放在此路径下，所以最终我们可执行二进制的沙箱物理路径为`/data/app/electron.org/electron_1.0/bin/electron/electron`或`/data/app/electron.org/electron_1.0/bin/electron/hello`。
2. 由于我们在`hnp.json`中也配置了软连接，所以会在`/data/app/`下生成一个软链接路径`bin/electron`，链接到上面的沙箱物理路径，关系如下
   ![](./res/1772006556418_image.png)
3. 由于软链接路径调用权限受限（调试时可以，上架不行），所以建议应用使用沙箱物理路径，即`/data/app/electron.org/electron_1.0/bin/electron/electron`。（查看方式文章前半部分有写：`nsenter -t 进程号 -m sh`，使用该命令进入进程沙箱。）


# 二、让子进程启动二进制hello
## 1. 编写一个可执行二进制：hello
### 1.1 环境变量配置
首先，要进行环境变量配置，原因有两个：第一，鸿蒙平台架构不同于其他平台，需要使用特定的工具链进行编译；第二，如果需要在Electron内部调用，则编译工具链需要使用Electron提供的指定版本。

应用可在鸿蒙Electron的指定目录下找到工具链，并进行如下配置

```
export CC="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/clang --target=aarch64-linux-ohos"
export CXX="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/clang++ --target=aarch64-linux-ohos"
export LD="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/lld --target=aarch64-linux-ohos"
export STRIP="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-strip"
export RANLIB="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-ranlib"
export OBJDUMP="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-objdump"
export OBJCOPY="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-objcopy"
export NM="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-nm"
export AR="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-ar"
export CFLAGS="-fPIC -D__MUSL__=1"
export CXXFLAGS="-fPIC -D__MUSL__=1"
```

### 1.2 Demo编写

`hello.c`

```
#include <stdio.h>

int main(int argc, char *argv[]) {
    printf("hello from C binary\n");

    printf("argc = %d\n", argc);

    for (int i = 1; i < argc; i++) {
        printf("arg[%d] = %s\n", i, argv[i]);
    }

    return 0;
}
```

执行`$CC $CFLAGS hello.c -o hello`即可生成可执行二进制`hello`。

## 2. HNP构建和继承
参考上述章节中的内容即可，只需要把electron二进制替换成hello二进制即可，目录结构如下：
```
hnp
├── bin
│   └── electron
│       └── hello (关键)
└── hnp.json
```
其余相同，不再赘述

## 3. 执行hello二进制的Demo代码

`main.js`

```
const { app, BrowserWindow, Tray, nativeImage, ipcMain } = require('electron');
const { spawn } = require("child_process");
const path = require('path');

let mainWindow, tray;

function createWindow() {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'electron_white.png')));
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: __dirname + "/preload.js"
        }
    });

    mainWindow.loadFile("index.html");
}

ipcMain.handle("run-binary", async (_, args = []) => {
    return new Promise((resolve, reject) => {
        // const binPath = "/data/app/electron.org/electron_1.0/bin/electron/hello";
        const binPath = "/data/app/bin/electron/hello";
        const child = spawn(binPath, args, {
            cwd: path.dirname(binPath),
            stdio: ["ignore", "pipe", "pipe"]
        });

        let output = "";

        child.stdout.on("data", data => {
            output += data.toString();
        });

        child.stderr.on("data", data => {
            output += data.toString();
        });

        child.on("error", err => {
            reject(err.message);
        });

        child.on("close", code => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(`exit code ${code}\n${output}`);
            }
        });
    });
});

app.whenReady().then(createWindow);
```

`preload.js`

```
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
    runBinary: (args) => ipcRenderer.invoke("run-binary", args)
});
```

`index.html`

```
<!DOCTYPE html>
<html>
<body>
<button id="run">Run Binary</button>
<pre id="out"></pre>

<script>
    document.getElementById("run").onclick = async () => {
      const out = document.getElementById("out");
      out.textContent = "running...\n";

      try {
        const result = await window.api.runBinary(["foo", "bar"]);
        out.textContent = result;
      } catch (e) {
        out.textContent = "error:\n" + e;
      }
    };
</script>
</body>
</html>
```

## 4. 验证结果

启动electron

![](./res/1772006530420_image.png)
点击调用

![](./res/1772006537936_image.png)