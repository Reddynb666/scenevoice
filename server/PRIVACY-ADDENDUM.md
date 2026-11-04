# SceneVoice Cloud: privacy addendum / 隐私补充说明

This applies only when SceneVoice's model source is set to **SceneVoice Cloud**. With your own API key, nothing below is involved: the extension talks to Google or Alibaba Cloud directly, as [PRIVACY.md](../PRIVACY.md) describes.

仅当 SceneVoice 的模型来源设置为 **SceneVoice Cloud** 时适用。使用自己的 API 密钥时，下文一概不涉及：扩展直接与 Google 或阿里云通信，见 [PRIVACY.md](../PRIVACY.md)。

## English

- **No account.** When you choose SceneVoice Cloud, the extension asks the relay for an anonymous device token. The relay stores the token, the plan (free, Plus, organisation) and the date it was made, nothing about you, your browser or your computer.
- **What passes through.** The same request the extension would send with your own key (the video link or small pictures of the playing video, the title, the captions and your question) goes to the relay, which forwards it to the model with the operator's key and sends the answer back. The relay does not keep or log request bodies, and does not open them except to read the model name from a free-plan request to Alibaba Cloud (that API names the model inside the request). Pictures and questions are never stored.
- **What is counted.** Per device and per UTC day: how many seconds of video were described (from the model's token counts), how many model requests were made in the current minute and how many descriptions were shared. The counters expire after two days at most. New registrations are counted per network address for one day using a one-way hash of the address; the address itself is not stored.
- **Shared descriptions.** When *Share descriptions* is on (the default with SceneVoice Cloud), a finished description script is sent to the relay as text: the timestamps and sentences, the language, the video id and the model name. The relay keeps it for 180 days so the next person who opens the same video hears it without a new model run. It is stored without any reference to who made it; the first script stored for a video stays until it expires or the operator removes it. No pictures, no questions, no answers to questions.
- **Logs.** One line per request: the route, the status code, the first 8 characters of the token and the seconds charged. No addresses, no bodies, no video ids.
- **Upstream.** The relay forwards to Google's Gemini API (or, in a mainland-China deployment, Alibaba Cloud Model Studio). Their terms apply to the forwarded content, as with your own key.
- **Payments.** Plus and organisation licences are keys like `svl-XXXX-XXXX-XXXX`. The relay stores the key, the plan, the seat count and the Stripe session id. Payment details stay with Stripe; the relay never sees them.
- **No tracking.** No analytics, no advertising identifiers, no sale of data, no accessibility feature behind a paywall.

## 简体中文

- **不需要账号。** 选择 SceneVoice Cloud 时，扩展会向中继服务器申请一个匿名的设备令牌。服务器只保存令牌、所属档位（免费、Plus、机构）和创建日期，不保存关于您、您的浏览器或电脑的任何信息。
- **经过中继的内容。** 与使用自己密钥时发送的请求完全相同（视频链接或正在播放画面的小图、标题、字幕和您提出的问题），先到中继服务器，再由服务器用运营者的密钥转发给模型，并把回答原样返回。服务器不保存、不记录请求内容，也不打开请求内容——唯一的例外是免费档位发往阿里云的请求，服务器只读取其中的模型名称（该接口把模型名写在请求体里）。画面和问题从不存储。
- **统计什么。** 按设备、按 UTC 日期统计已描述的视频秒数（由模型返回的 token 数折算）、当前一分钟内的模型请求次数，以及当天共享的描述份数，计数最多两天后自动过期。新注册按网络地址每天计数，用的是地址的单向哈希值，地址本身不保存。
- **共享描述。** 开启"共享描述"（使用 SceneVoice Cloud 时默认开启）后，生成完成的口述脚本会以纯文本发送到服务器：时间点和句子、语言、视频编号和模型名称。服务器保留 180 天，下一位打开同一视频的人可以直接听到，不必再跑一次模型。存储时不关联任何提交者信息；一个视频最先存入的脚本会一直保留到过期或由运营者删除。没有图片，没有问题，也没有对问题的回答。
- **日志。** 每个请求一行：路由、状态码、令牌前 8 位、计入的秒数。没有地址、没有请求内容、没有视频编号。
- **上游服务。** 服务器转发到 Google 的 Gemini API（中国内地部署则转发到阿里云百炼）。转发内容适用它们的条款，与您使用自己的密钥时相同。
- **付费。** Plus 与机构许可是形如 `svl-XXXX-XXXX-XXXX` 的密钥。服务器保存密钥、档位、席位数和 Stripe 会话编号；支付信息留在 Stripe，服务器看不到。
- **不跟踪。** 没有统计分析、没有广告标识、不出售数据，任何无障碍功能都不设付费墙。
