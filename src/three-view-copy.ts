export const threeViewCopy = {
  zh: {
    enable: '生成三视图（正面／侧面／背面）',
    hyperreal: '超写实（固定）',
    styleHint: '三视图提交时始终附加超写实约束，补充或自定义提示词不改变固定风格。',
    modeHint:
      '仅保留 16:9 和 3:2；固定超写实风格、直立参考姿势，不继承动漫或插画画风。勾选不自动发起 3D 建模，图片生成仍消耗生图额度。',
    emptyHint:
      '选择服饰，可选人物参考，生成一张正面／侧面／背面的超写实三视图拼图；姿势参考不是必选。',
    loadingSheet: '正在读取三视图…',
    reconnect: '重试连接（原任务）',
    newTask: '重新生成 3D（新任务）',
    image: '三视图',
    model: '3D 模型',
    front: '正面',
    side: '侧面',
    back: '背面',
    left: '人物自身左侧',
    right: '人物自身右侧',
    sideView: '侧面方向',
    cropTitle: '确认三张建模参考图',
    cropHint:
      '初始裁切仅为三等分，不是自动识别。调整百分比边界，确认每张只含一个视角，头部、衣摆和鞋履完整入画。',
    x: '左边距 %',
    y: '上边距 %',
    width: '宽度 %',
    height: '高度 %',
    resetCrops: '重置裁切',
    confirm: '我已确认三图为同一人物、同一服饰与姿势，视角正确且整套完整入画',
    invalidCrop: '裁切边界无效：数值必须完整且位于图片范围内。',
    cropTooSmall: '最长边缩放到最多 2048 像素后，每个视角仍需至少 256×256 像素，请调整裁切。',
    cropOverlap: '三个裁切区域不能重叠，请调整边界。',
    imageFailed: '无法读取三视图，请重试。图片需允许跨域读取，且不超过 20 MB／4000 万像素。',
    retry: '重试',
    generate: '生成 3D',
    generating: '正在建模',
    cancel: '停止等待',
    cancelHint: '停止等待不保证终止服务商任务，也不保证退还已消耗的额度。',
    costHint:
      '此操作会把三张裁切图发送到后端配置的建模服务商（混元或 Tripo），并消耗其账户额度；结果是 AI 推断的模型，不保证精确还原。',
    service: '建模服务配置',
    serviceUrl: '后端 API 地址',
    accessToken: '后端访问令牌',
    serviceHint:
      '这里只填自建后端的访问令牌，不填混元或 Tripo API Key。令牌仅保存在当前标签页会话中。',
    queued: '排队中',
    preparing: '上传三视图',
    running: '生成模型',
    downloading: '下载模型',
    succeeded: '模型已完成',
    cancelled: '已停止等待',
    failed: '建模失败',
    modelHint: '拖拽旋转，滚轮或双指缩放。',
    rotate: '自动旋转',
    resetCamera: '复位视角',
    download: '下载 GLB',
    importModel: '导入 GLB 预览',
    importHint: '可先用已有 GLB 验证查看器，不调用付费接口；只接受资源内嵌的 GLB，最大 50 MB。',
    viewerFailed: '3D 查看器无法加载。请检查 WebGL 支持，或下载 GLB 在其他软件查看。',
    viewerLoading: '加载 3D 查看器…',
    noModel: '确认裁切后生成 3D，或导入已有 GLB 预览。',
    invalidService:
      '后端地址必须使用 HTTPS，或本地 localhost／127.0.0.1 的 HTTP 地址，不可带查询参数或账号密码。',
    missingToken: '请填写自建后端的访问令牌。',
    service_unavailable:
      '建模后端未启用，请检查 MODEL_PROVIDER、对应服务商密钥和后端访问令牌，按 README 配置。',
    unauthorized: '后端访问令牌无效，或此建模任务的访问凭证已失效。',
    origin_not_allowed: '后端未允许当前网站来源，请检查 MODEL_ALLOWED_ORIGINS。',
    queue_full: '建模队列已满，请稍后再试。',
    invalid_images: '三视图文件无效；必须提供正面、侧面、背面三张至少 256×256 的 PNG/JPEG 图片。',
    request_too_large: '上传内容过大，请缩小图片后再试。',
    provider_failed:
      '建模服务商请求或任务失败，请检查后端密钥、额度和服务状态；不会自动重新提交付费任务。',
    provider_auth_failed:
      '服务商密钥鉴权失败。检查后端当前服务商的 API Key 是否正确、有效且未被禁用；页面填写的是后端访问令牌，不是服务商 Key。',
    provider_access_denied:
      '服务商拒绝访问或当前接口不可用。检查服务是否开通、账号权限、IP 白名单及官方接口状态。',
    provider_resource_limited:
      '服务商报告资源或配额不足／资源占用。检查账户积分、可用额度和并发任务；此提示不能单独证明余额不足。',
    provider_invalid_request:
      '服务商拒绝了请求参数。检查模型版本、三视图字段格式和图片限制；更换密钥或充值不一定能解决。',
    provider_rejected:
      '服务商拒绝了请求，但具体原因尚未确认，不能仅凭 HTTP 400 判断是参数错误。先检查服务开通状态和任务记录；不要反复提交付费任务。',
    provider_rate_limited: '服务商请求频率受限；不会自动重新提交付费任务。',
    provider_unavailable:
      '建模服务商资源不可用或暂时故障。检查服务是否开通及当前任务记录，不会自动重新提交付费任务。',
    failureDetails: '脱敏诊断',
    hunyuan: '混元',
    providerTask: '服务商任务',
    providerCode: '服务商错误码',
    stage_upload: '上传三视图',
    stage_submit: '提交建模',
    stage_query: '查询任务',
    stage_download: '下载模型',

    submission_uncertain:
      '提交结果不确定。请先在当前建模服务商控制台检查任务记录，避免重复扣费，再决定是否创建新任务。',
    invalid_model: '模型文件无效、超过 50 MB 或包含外部资源；仅支持资源内嵌的 GLB 2.0。',
    task_not_found: '任务已过期或不存在，请重新生成。',
    timed_out: '建模等待超时；请先检查当前建模服务商的任务记录，避免重复扣费。',
    network_failed: '无法连接建模后端。可重试连接恢复同一任务；请检查服务地址、网络和跨域配置。',
    conflict: '重复提交标识对应了不同图片，请重新确认裁切。',
    unknown: '建模失败，请检查后端日志后再试。',
  },
  en: {
    enable: 'Generate three views (front / side / back)',
    hyperreal: 'Hyperrealistic (fixed)',
    styleHint:
      'A fixed hyperrealistic requirement is always appended on submission, including supplemental or custom prompts.',
    modeHint:
      'Only 16:9 and 3:2 are available. Uses a fixed hyperrealistic style and neutral upright stance, not reference anime or illustration styles. The checkbox does not start 3D modeling; image generation still uses image credits.',
    emptyHint:
      'Choose an outfit and optional character to generate one hyperrealistic front / side / back reference sheet. A pose reference is optional.',
    loadingSheet: 'Reading the reference sheet…',
    reconnect: 'Reconnect to same task',
    newTask: 'Generate again (new task)',
    image: 'Three views',
    model: '3D model',
    front: 'Front',
    side: 'Side',
    back: 'Back',
    left: "Character's left",
    right: "Character's right",
    sideView: 'Side direction',
    cropTitle: 'Confirm three modeling references',
    cropHint:
      'Initial crops are equal thirds, not detected boundaries. Adjust percentages; each crop must contain one complete head-to-sole view with margins.',
    x: 'Left %',
    y: 'Top %',
    width: 'Width %',
    height: 'Height %',
    resetCrops: 'Reset crops',
    confirm:
      'I confirm the same person, outfit and pose, correct views and complete head-to-sole framing',
    invalidCrop: 'Invalid crop: all values must be present and inside the image.',
    cropTooSmall:
      'Each view must remain at least 256×256 pixels after its longest side is capped at 2048. Adjust crops.',
    cropOverlap: 'Crop regions must not overlap.',
    imageFailed:
      'Cannot read the sheet. Images need CORS access and must stay within 20 MB / 40 megapixels.',
    retry: 'Retry',
    generate: 'Generate 3D',
    generating: 'Modeling',
    cancel: 'Stop waiting',
    cancelHint: 'Stopping may not cancel the provider task or refund consumed credits.',
    costHint:
      'Sends the three cropped images to the backend-configured provider (Hunyuan or Tripo) and consumes account credits. AI-inferred models are not exact reconstructions.',
    service: 'Modeling service settings',
    serviceUrl: 'Backend API URL',
    accessToken: 'Backend access token',
    serviceHint:
      'Use your backend access token, NOT a Hunyuan or Tripo API key. Stored only in this tab session.',
    queued: 'Queued',
    preparing: 'Uploading views',
    running: 'Generating model',
    downloading: 'Downloading model',
    succeeded: 'Model ready',
    cancelled: 'Stopped waiting',
    failed: 'Modeling failed',
    modelHint: 'Drag to rotate. Scroll or pinch to zoom.',
    rotate: 'Auto rotate',
    resetCamera: 'Reset camera',
    download: 'Download GLB',
    importModel: 'Import GLB preview',
    importHint:
      'Test with an existing GLB without paid API calls. Embedded resources only; maximum 50 MB.',
    viewerFailed: 'Cannot load the 3D viewer. Check WebGL or download the GLB for another viewer.',
    viewerLoading: 'Loading 3D viewer…',
    noModel: 'Confirm crops to generate 3D, or import a GLB preview.',
    invalidService:
      'Use HTTPS, or HTTP on localhost / 127.0.0.1, with no credentials, query or fragment.',
    missingToken: 'Enter your backend access token.',
    service_unavailable:
      'Check MODEL_PROVIDER, its provider API key and the backend access token as described in README.',
    unauthorized: 'Invalid backend token or expired task credentials.',
    origin_not_allowed: 'This website origin is not allowed. Check MODEL_ALLOWED_ORIGINS.',
    queue_full: 'Modeling queue is full. Try later.',
    invalid_images: 'Provide front, side and back PNG/JPEG images, each at least 256×256 pixels.',
    request_too_large: 'Upload too large. Reduce the image sizes.',
    provider_failed:
      'Provider request or task failed. Check backend credentials, credits and service status. Paid tasks are not resubmitted automatically.',
    provider_auth_failed:
      'Provider API key authentication failed. Check the backend provider key. The page requires your backend access token, not the provider key.',
    provider_access_denied:
      'Provider access denied or endpoint unavailable. Check service activation, account permissions, IP allowlist and the official endpoint status.',
    provider_resource_limited:
      'Provider resources or quota are limited or busy. Check credits, available quota and concurrent tasks; this alone does not prove insufficient balance.',
    provider_invalid_request:
      'Provider rejected the request parameters. Check the model version, multiview fields and image limits; changing keys or buying credits may not help.',
    provider_rejected:
      'Provider rejected the request, but the cause is unconfirmed. HTTP 400 alone does not prove invalid parameters. Check service activation and task history; do not repeatedly submit paid tasks.',
    provider_rate_limited:
      'Provider rate limit reached. Paid tasks are not resubmitted automatically.',
    provider_unavailable:
      'Provider resources are unavailable or a temporary failure occurred. Check service activation and task history; paid tasks are not resubmitted automatically.',
    failureDetails: 'Safe diagnostics',
    hunyuan: 'Hunyuan',
    providerTask: 'Provider task',
    providerCode: 'Provider error code',
    stage_upload: 'Upload views',
    stage_submit: 'Submit modeling',
    stage_query: 'Query task',
    stage_download: 'Download model',

    submission_uncertain:
      'Submission outcome is uncertain. Check your current provider task history before creating another paid task.',
    invalid_model:
      'Invalid model, larger than 50 MB, or external resources found. Only self-contained GLB 2.0 is supported.',
    task_not_found: 'Task expired or not found. Generate again.',
    timed_out:
      'Modeling timed out. Check your current provider task history before submitting again.',
    network_failed:
      'Cannot reach the backend. Retry to reconnect to the same task. Check the URL, network and CORS.',
    conflict: 'This submission identifier belongs to different images. Confirm crops again.',
    unknown: 'Modeling failed. Check backend logs before retrying.',
  },
} as const;
