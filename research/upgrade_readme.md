# electron鸿蒙项目升级文档

[返回主页](../../README.md)

## 1、背景

以前electron鸿蒙项目的开发打包流程，是将electron工程中的构建产物以及涉及的依赖，手动拷贝到鸿蒙工程（ohos_hap）的\ohos_hap\web_engine\src\main\resources\resfile\resources路径下，再在Deveco工程中进行构建打包出hap包。因手动拷贝耗时，因此在鸿蒙工程升级后，需要重新手动拷贝到新的鸿蒙工程里面，导致编码外的工作量较大。

## 2、解决方案

使用electron-builder解决此问题，electron-builder是一款打包工具，windows和mac上均可以使用它打包出对应系统的可执行文件。目前electron-builder鸿蒙版本已经发布，因此可以在electron工程中打包出hap包，这样无需手动拷贝操作，仅需配置最新鸿蒙工程路径，即可完成升级。

简单来讲，以前的开发流程，是在electron工程中完成开发后，将构建产物手动拷贝到鸿蒙工程进行打包。现在借助electron-builder，实现鸿蒙工程与electron工程解耦，如果electron工程升级，只需要将electron工程中的package.json文件中的ohosHapPath路径配置为新的鸿蒙工程路径即可。

![upgrade](./res/upgrade.png)

electron-builder工具具体操作步骤如下：

### 2.1 安装鸿蒙版electron-builder

在electron工程根目录中，执行如下命令：

```shell
npm install @electron-ohos/electron-builder --save-dev
```

### 2.2 在electron工程的package.json中进行配置

#### (1) 添加打包命令

在scripts配置项中添加：

```json
"dist:ohos": "electron-builder-ohos --ohos"
```

可以执行命令npm run dist:ohos进行打包。

#### (2) 添加环境配置项（必须）

在build配置项中添加：

```json
"ohos": {
 "target": [
  "hap"
 ],
 "hvigorwPath": "D:/software/DevEco/deveco-studio-5.1.1.406SP1.win/deveco-studio/tools/hvigor/bin",
 "ohpmPath": "D:/software/DevEco/deveco-studio-5.1.1.406SP1.win/deveco-studio/tools/ohpm/bin",
 "sdkPath": "D:/software/DevEco/deveco-studio-5.1.1.406SP1.win/deveco-studio/sdk",
 "ohosHapPath": "D:/project/electron/v34.5.4-20250918.1-release/libelectron_132/libelectron/ohos_hap"
}
```

target: 指定打包的类型，默认为hap

hvigorwPath：配置hvigorw工具的路径（可以在deveco的安装目录或打包工具目录中找到）

ohpmPath：ohpm工具路径（可以在deveco的安装目录或打包工具目录中找到）

sdkPath：sdk路径（可以在deveco的安装目录或打包工具目录中找到）

ohosHapPath：进行编译需要的鸿蒙工程路径，可以通过华为账号在[这里](https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home?ref=main)进行下载，鸿蒙工程可以在编译产物解压缩后找到。

#### (3) 基本信息配置

appId（必填）: 应用ID，会映射到hap包的bundleName，格式xx.xx.xx(必填)。

productName：产品名称，映射到hap包的应用名称，如果为空，则取name值。

icon：应用图标，如果不设置，将使用electron默认图标。

#### (4) 添加签名证书配置（签名包必须）

在ohos节点添加：

```json
"ohos": {
 "certPath": "D:/cert/debug.cer",
 "profile": "D:/cert/helloworld.p7b",
 "keyAlias": "helloworld",
 "keyPassword": "123456",
 "storeFile": "D:/cert/helloworld.p12",
 "storePassword": "123456"
}
```

certPath: 证书地址。

profile: profile地址，格式为.p7b。

keyAlias: 必填，别名，用于标识密钥名称。

keyPassword: 别名密码（既可以在配置文件中配置，也支持在环境变量设置OH_KEY_PWD="123456"）

storeFile: 本地秘钥地址

storePassword: 本地秘钥密码。（既可以在配置文件中配置，也支持在环境变量设置OH_STORE_PWD="123456"）

**申请方式：** 首先创建storeFile（[创建方式链接](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing#section462703710326)），然后申certPath和profile（[创建方式链接](https://developer.huawei.com/consumer/cn/doc/app/agc-help-add-debugcert-0000001914263178)）

#### (5) 原生模块

如果electron工程中使用了原生模块，需要自行进行交叉编译后，将编译后的产物重新放回electron工程的node_modules相应的模块中，electron-builder会在打包时将编译后的产物打包到对应的位置。

#### (6) 权限配置

如果electron工程中用到了electron框架不具备的权限，需要在ohos节点添加requestPermissions配置项：

```json
"ohos": {
  "requestPermissions": [
    {
      "name": "ohos.permission.xxx",
      "reason": "xxx",
  	  "usedScene": {
        "abilities": [
          "FormAbility"
         ],
        "when": "always"
      }
    }
  ]
}
```

#### (7) skills配置

如果应用存在应用间跳转需求，需要配置Deep Linking，配置格式[参见](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/deep-linking-startup)。electron-builder中提供了响应的配置项，可以在打包时自动进行配置项的同步，需要在package.json的ohos节点，添加skills配置项：

```json
"ohos": {
  "skills": [
    {
      "actions": [
        "example.want.action.viewData"
       ],
       "uris": [
         {
           "scheme": "www.example.com"
         }
       ]
     }
  ]
}
```



#### (8) 配置项总结

```json
{
    "name": "helloworld",
    "version": "1.0.0",
    "description": "",
    "license": "ISC",
    "author": "",
    "type": "commonjs",
    "main": "index.js",
    "scripts": {
        "app:dir": "electron-builder --dir",
        "app:dist": "electron-builder",
        "build": "npm run build:renderer && npm run build:main",
        "build:renderer": "webpack --config webpack.renderer.config.js",
        "build:main": "webpack --config webpack.main.config.js",
        "dist:ohos": "electron-builder-ohos --ohos",
        "start": "electron .",
        "test": "echo \"Error: no test specified\" && exit 1"
    },
    "build": {
        "appId": "com.example.helloworld",
        "productName": "HelloWorld",
        "ohos": {
            "icon": "./heart.png",
            "target": [
                "hap"
            ],
            "hvigorwPath": "D:/software/DevEco/deveco-studio-5.1.1.406SP1.win/deveco￾studio/tools/hvigor/bin",
            "ohpmPath": "D:/software/DevEco/deveco-studio-5.1.1.406SP1.win/deveco￾studio/tools/ohpm/bin",
            "sdkPath": "D:/software/DevEco/deveco-studio-5.1.1.406SP1.win/deveco-studio/sdk",
            "ohosHapPath": "D:/project/electron/v34.5.4-20250918.1-release/libelectron_132/libelectron/ohos_hap",
            "certPath": "D:/cert/debug.cer",
            "profile": "D:/cert/helloworld.p7b",
            "keyAlias": "helloworld",
            "keyPassword": "123456",
            "storeFile": "D:/cert/helloworld.p12",
            "storePassword": "123456",
            "requestPermissions": [
                {
                    "name": "ohos.permission.xxx",
                    "reason": "xxx",
                    "usedScene": {
                        "abilities": [
                            "FormAbility"
                        ],
                        "when": "always"
                    }
                }
            ],
            "skills": [
                {
                    "actions": [
                        "example.want.action.viewData"
                    ],
                    "uris": [
                        {
                            "scheme": "www.example.com"
                        }
                    ]
                }
            ]
        }
    },
    "devDependencies": {

    },
    "dependencies": {

    }
}
```

### 2.3 执行打包

```shell
npm run dist:ohos
```

在./dist/ohos-unpacked目录下，可以看到打包出的hap包文件

![image-20260420114328807](./res/image-20260420114328807.png)