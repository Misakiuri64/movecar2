# MoveCar2 Worker - 多车多用户版 挪车通知系统
基于 Cloudflare Workers 的智能挪车通知系统，扫码即可通知车主，保护双方隐私。
代码基于https://github.com/lesnolie/movecar 的版本建立,在此感谢该作者
的无私奉献。

## 界面预览

| 请求者页面 | 车主页面 |
|:---:|:---:|
| [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/Misakiuri64/movecar2/blob/main/preview-requester.html) | [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/Misakiuri64/movecar2/blob/main/preview-owner.html) |

## 为什么需要它？

- 🚗 **被堵车却找不到车主** - 干着急没办法
- 📱 **传统挪车码暴露电话** - 隐私泄露、骚扰电话不断
- 😈 **恶意扫码骚扰** - 有人故意反复扫码打扰
- 🤔 **路人好奇扫码** - 并不需要挪车却触发通知

## 这个系统如何解决？

- ✅ **不暴露电话号码** - 通过推送通知联系，保护隐私
- ✅ **双向位置共享** - 车主可确认请求者确实在车旁
- ✅ **无位置延迟 30 秒** - 降低恶意骚扰的动力
- ✅ **免费部署** - Cloudflare Workers 免费额度完全够用
- ✅ **无需服务器** - Serverless 架构，零运维成本

## 为什么使用 Bark 推送？

- 🔔 支持「紧急 / 重要 / 警告」通知级别
- 🎵 可自定义通知音效
- 🌙 **即使开启勿扰模式也能收到提醒**
  
- 📱 所有用户可以使用Server酱，并安装Server酱App,并注册获得SCTAPIkey录入即可。（不建议使用Server酱微信公众号的通知，不带有弹窗。）

## 使用流程

### 请求者（需要挪车的人）

1. 扫描车上的二维码(有车牌信息的链接二维码)，直接进入通知页面4
2. 扫描车上的二维码(无车牌信息的链接二维码），进入车牌输入页面3
   (为何有不带车牌的页面，因为这样可以批量印刷挪车码，同时二维码不会泄露自己的车牌号，只需要请求者扫码后自己输入车牌即可)
3. 车牌输入页面-输入车牌，验证车牌通过进入通知页面4
4. 通知页面-填写留言（可选），如「挡住出口了」
5. 允许获取位置（不允许则延迟 30 秒再发送）
6. 点击「通知车主」（在第三次通知的180s后可显示拨打电话的链接）。
7. 等待车主确认，可查看车主位置


### 车主

1. 收到 Bark/Server酱的推送通知
2. 点击通知进入确认页面
3. 查看请求者位置（判断是否真的在车旁）
4. 根据需要决定是否分享车主位置
5. 点击确认，根据需要决定是否显示拨打电话链接。

### 流程图

    Start((开始)) --> Input[挪车人输入车牌]
    Input --> Verify{车牌校验}
    
    Verify -- 不存在 --> Error[提示车牌未登记]
    Verify -- 存在 --> LocCheck{是否获取定位?}

    LocCheck -- 允许 --> SendNow[立即发送通知]
    LocCheck -- 拒绝 --> Delay[延迟30秒发送通知]

    SendNow --> Push[触发 Bark/Server酱 推送]
    Delay --> Push

    Push --> Polling[挪车人进入倒计时/状态轮询]

    subgraph 车主端处理
        Push -.-> OwnerPage[车主打开确认页]
        OwnerPage --> SetAuth[选择: 分享位置 / 允许通话]
        SetAuth --> Confirm[点击: 我已知晓, 正在前往]
    end

    Confirm --> KV[更新 KV 状态: confirmed]
    
    Polling --> Check{检查 KV 状态}
    Check -- 等待中 --> Polling
    Check -- 已确认 --> Success[展示车主位置/震动提醒]
    
    Success --> CallCheck{是否激活拨号?}
    CallCheck -- 车主授权或重试3次 --> Call[显示拨打电话按钮]
    CallCheck -- 未满足条件 --> Wait[继续等待]

## 部署教程

### 第一步：注册 Cloudflare 账号

1. 打开 https://dash.cloudflare.com/sign-up
2. 输入邮箱和密码，完成注册

### 第二步：创建 Worker

1. 登录后点击左侧菜单「Workers & Pages」
2. 点击「创建应用程序」→「从Hello World!开始」
3. 名称填 `movecar2`（或你喜欢的名字）
4. 点击「部署」
5. 点击「编辑代码」，删除默认代码
6. 复制 `movecar2.js` 全部内容粘贴进去
7. 点击右上角「部署」保存

### 第三步：创建 KV 存储

1. 左侧菜单点击「Workers KV」
2. 点击「Create Instance」
3. 名称填 `Movecar2KV`，点击「创建」
4. 回到你的 Worker →「查看绑定」→「添加绑定」
5. 选择「KV 命名空间」→ 点击「添加绑定」
6. 「变量名称」 填 `MOVE_CAR_STATUS`
7. 选择刚创建的KV命名空间「Movecar2KV」，点击「部署」

### 第四步：配置环境变量

1. Worker →「设置」→「变量和机密」
2. 添加以下变量：
  变量名称=CAR_LIST
* CAR_LIST: 必需。格式为CSV，每行一条: 车牌号,<BARK/SCTAPI>/YourKey/,电话号码(可选)
 * 示例:
 * 沪A888666, &lt;SCTAPI&gt;/Yourkey/,02166668888
 * 苏E12345, &lt;BARK&gt;/YourKey/,13800000000
 
### 第五步：绑定域名（可选）

1. Worker →「设置」→「域和路由」
2. 点击「添加」→「自定义域」
3. 输入你的域名如「movecar2.abc.com」，按提示完成 DNS 配置

## 制作挪车码

### 生成二维码

1. 复制你的 Worker 自定义域地址（如无车牌的二维码链接 `https://movecar2.abc.com`或有车牌的二维码链接`https://movecar2.abc.com/notify?plate=%E6%B2%AAA888666`）
2. 使用任意二维码生成工具（如 草料二维码、QR Code Generator）
3. 将链接转换为二维码并下载

## License

MIT
