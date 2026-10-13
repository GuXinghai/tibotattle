// Canonical Electron main-process ownership input.
// This file is consumed by scripts/generate-i18n-electron-copy.js and is not staged at runtime.
// Keep desktop-only copy here; canonical shared copy belongs in packages/i18n.

export const DESKTOP_SHARED_KEYS = Object.freeze(["electron.menu.about","electron.menu.edit","electron.menu.exit","electron.menu.file","electron.menu.focus","electron.menu.help","electron.menu.open","electron.menu.quit","electron.menu.settings","electron.menu.show","electron.menu.view","electron.menu.window","electron.settings.codexFolder.default","electron.settings.login.status.disabled","electron.settings.login.status.enabled","electron.settings.login.status.error","electron.settings.login.status.needsApproval","electron.settings.login.status.unavailable","electron.settings.notifications.permissionStatus","electron.settings.notifications.status.capabilityError","electron.settings.notifications.status.developmentUnavailable","electron.settings.notifications.status.ready","electron.settings.notifications.status.unavailable","electron.settings.notifications.status.unsupported","electron.settings.notifications.status.windowsIdentityUnavailable","electron.settings.updates.unavailable","electron.tray.about","electron.tray.customize","electron.tray.dualMeterHint","electron.tray.low","electron.tray.open","electron.tray.quit","electron.tray.refresh","electron.tray.resetClock","electron.tray.resetCountdown","electron.tray.retry","electron.tray.selectedUnavailable","electron.tray.settings","electron.tray.statusUnavailable"]);

export const DESKTOP_OVERLAY_MESSAGES = Object.freeze({
  "electron.settings.codexRoots.savedFolderUnavailable": Object.freeze({
    "en-US": "The saved Codex folder was unavailable. The default folder is active; choose a folder again in Settings.",
    "zh-Hans": "保存的 Codex 文件夹不可用，已改用默认文件夹。请在“设置”中重新选择文件夹。",
    "es": "La carpeta de Codex guardada no estaba disponible. Se está usando la carpeta predeterminada; elige otra carpeta en Configuración.",
  }),
  "electron.settings.codexRoots.restartFailed": Object.freeze({
    "en-US": "The selected Codex folders were saved, but the local companion could not restart. Retry to apply them.",
    "zh-Hans": "所选的 Codex 文件夹已保存，但本地辅助服务未能重启。请重试以应用这些文件夹设置。",
    "es": "Las carpetas de Codex seleccionadas se guardaron, pero el servicio auxiliar local no pudo reiniciarse. Reintenta para aplicarlas.",
  }),
  "electron.recovery.supportCode": Object.freeze({
    "en-US": "Support code: {code}.",
    "zh-Hans": "支持代码：{code}。",
    "es": "Código de soporte: {code}.",
  }),
  "electron.secureStorage.title": Object.freeze({
    "en-US": "Unable to prepare secure storage",
    "zh-Hans": "无法准备安全存储",
    "es": "No se pudo preparar el almacenamiento seguro",
  }),
  "electron.secureStorage.preserved": Object.freeze({
    "en-US": "No credential was created, replaced, or deleted.",
    "zh-Hans": "未创建、替换或删除任何凭据。",
    "es": "No se creó, sustituyó ni eliminó ninguna credencial.",
  }),
  "electron.secureStorage.locked.message": Object.freeze({
    "en-US": "Windows Credential Manager is locked for TiboTattle.",
    "zh-Hans": "TiboTattle 所需的 Windows 凭据管理器已锁定。",
    "es": "El Administrador de credenciales de Windows que necesita TiboTattle está bloqueado.",
  }),
  "electron.secureStorage.locked.detail": Object.freeze({
    "en-US": "Unlock your Windows session, then choose Retry.",
    "zh-Hans": "请解锁 Windows 会话，然后点击“重试”。",
    "es": "Desbloquea tu sesión de Windows y después elige Reintentar.",
  }),
  "electron.secureStorage.denied.message": Object.freeze({
    "en-US": "Windows denied TiboTattle access to a required secure credential.",
    "zh-Hans": "Windows 拒绝 TiboTattle 访问所需的安全凭据。",
    "es": "Windows denegó a TiboTattle el acceso a una credencial segura necesaria.",
  }),
  "electron.secureStorage.denied.detail": Object.freeze({
    "en-US": "Confirm TiboTattle runs under the Windows account that owns its existing credential, then choose Retry. Do not delete or reset the credential.",
    "zh-Hans": "请确认 TiboTattle 与拥有现有凭据的 Windows 账户一致，然后点击“重试”。请勿删除或重置凭据。",
    "es": "Confirma que TiboTattle se ejecuta con la cuenta de Windows que posee su credencial existente y elige Reintentar. No elimines ni restablezcas la credencial.",
  }),
  "electron.secureStorage.migration_required.message": Object.freeze({
    "en-US": "An existing TiboTattle credential requires migration.",
    "zh-Hans": "现有的 TiboTattle 凭据需要迁移。",
    "es": "Es necesario migrar una credencial existente de TiboTattle.",
  }),
  "electron.secureStorage.migration_required.detail": Object.freeze({
    "en-US": "Quit and contact support with the support code below. The legacy credential is preserved. Do not delete or reset credentials or app data. Retry only repeats the secure credential check; neither Retry nor reinstalling this release migrates the credential.",
    "zh-Hans": "请退出，并提供下方的支持代码联系支持。旧凭据已保留。请勿删除或重置凭据或应用数据。“重试”只会重新检查安全凭据；重试或重新安装此版本均无法迁移凭据。",
    "es": "Sal y contacta con soporte indicando el código de abajo. La credencial antigua se conserva. No elimines ni restablezcas credenciales ni datos de la aplicación. Reintentar solo repite la comprobación de la credencial segura; ni reintentar ni reinstalar esta versión migra la credencial.",
  }),
  "electron.secureStorage.timeout.message": Object.freeze({
    "en-US": "Windows did not finish the secure credential check in time.",
    "zh-Hans": "Windows 未能在规定时间内完成安全凭据检查。",
    "es": "Windows no terminó a tiempo la comprobación de la credencial segura.",
  }),
  "electron.secureStorage.timeout.detail": Object.freeze({
    "en-US": "Wait for Windows Credential Manager to respond, then choose Retry. TiboTattle will not retry automatically.",
    "zh-Hans": "请等待 Windows 凭据管理器恢复响应后点击“重试”。TiboTattle 不会自动重试。",
    "es": "Espera a que el Administrador de credenciales de Windows responda y elige Reintentar. TiboTattle no reintentará automáticamente.",
  }),
  "electron.secureStorage.credential_invalid.message": Object.freeze({
    "en-US": "A required TiboTattle credential could not be validated.",
    "zh-Hans": "无法验证 TiboTattle 所需的凭据。",
    "es": "No se pudo validar una credencial necesaria de TiboTattle.",
  }),
  "electron.secureStorage.credential_invalid.detail": Object.freeze({
    "en-US": "The credential was preserved. Do not delete or reset it; quit and contact support with the support code below.",
    "zh-Hans": "凭据已保留。请勿删除或重置凭据；请退出，并提供下方的支持代码联系支持。",
    "es": "La credencial se conserva. No la elimines ni restablezcas; sal y contacta con soporte indicando el código de abajo.",
  }),
  "electron.secureStorage.adapter_integrity_failed.message": Object.freeze({
    "en-US": "TiboTattle's secure storage component failed verification.",
    "zh-Hans": "TiboTattle 的安全存储组件未通过验证。",
    "es": "El componente de almacenamiento seguro de TiboTattle no superó la verificación.",
  }),
  "electron.secureStorage.adapter_integrity_failed.detail": Object.freeze({
    "en-US": "Quit and reinstall an untouched TiboTattle release for this PC, then try again.",
    "zh-Hans": "请退出，重新安装适用于这台电脑的未修改版 TiboTattle，然后再试。",
    "es": "Sal y reinstala una versión sin modificar de TiboTattle para este PC; después inténtalo de nuevo.",
  }),
  "electron.secureStorage.security_unavailable.message": Object.freeze({
    "en-US": "Windows Credential Manager is currently unavailable to TiboTattle.",
    "zh-Hans": "TiboTattle 目前无法使用 Windows 凭据管理器。",
    "es": "El Administrador de credenciales de Windows no está disponible para TiboTattle en este momento.",
  }),
  "electron.secureStorage.security_unavailable.detail": Object.freeze({
    "en-US": "Open Windows Credential Manager and confirm it is available, then choose Retry. If this continues, contact support.",
    "zh-Hans": "请打开“凭据管理器”，确认其可用后点击“重试”。如果问题持续，请联系支持。",
    "es": "Abre el Administrador de credenciales de Windows, confirma que está disponible y elige Reintentar. Si el problema continúa, contacta con soporte.",
  }),
  "electron.diagnostics.copy": Object.freeze({
    "en-US": "Copy diagnostics",
    "zh-Hans": "复制诊断信息",
    "es": "Copiar diagnósticos",
  }),
  "electron.diagnostics.done": Object.freeze({
    "en-US": "Done",
    "zh-Hans": "完成",
    "es": "Listo",
  }),
  "electron.diagnostics.enableCapture": Object.freeze({
    "en-US": "Enable local crash capture next launch",
    "zh-Hans": "下次启动时启用本地崩溃捕获",
    "es": "Activar captura local al reiniciar",
  }),
  "electron.diagnostics.disableCapture": Object.freeze({
    "en-US": "Disable local crash capture next launch",
    "zh-Hans": "下次启动时停用本地崩溃捕获",
    "es": "Desactivar captura local al reiniciar",
  }),
  "electron.diagnostics.openCrashFolder": Object.freeze({
    "en-US": "Open local crash reports",
    "zh-Hans": "打开本地崩溃报告",
    "es": "Abrir informes de fallos locales",
  }),
  "electron.diagnostics.prepareSupportIssue": Object.freeze({
    "en-US": "Prepare public GitHub issue…",
    "zh-Hans": "准备 GitHub 公开问题报告…",
    "es": "Preparar incidencia pública en GitHub…",
  }),
  "electron.diagnostics.message": Object.freeze({
    "en-US": "Review this content-free report. Preparing a public issue sends it to GitHub in the URL; review the form before submitting. Local crash dumps may contain private data and are not uploaded by TiboTattle. Capture changes take effect after restart.",
    "zh-Hans": "请检查这份不含会话内容的诊断报告。准备公开问题报告时，会通过网址将报告发送给 GitHub；提交前请检查表单。本地崩溃转储文件可能包含私密数据，TiboTattle 不会上传这些文件。崩溃捕获设置将在重启后生效。",
    "es": "Revisa este informe sin contenido. Preparar una incidencia pública lo envía a GitHub en la URL; revisa el formulario antes de publicarlo. Los volcados locales pueden contener datos privados y TiboTattle no los sube. Los cambios de captura se aplican tras reiniciar.",
  }),
  "electron.diagnostics.title": Object.freeze({
    "en-US": "TiboTattle doctor",
    "zh-Hans": "TiboTattle 诊断工具",
    "es": "Diagnóstico de TiboTattle",
  }),
  "electron.firstRun.checkbox.startAtLogin": Object.freeze({
    "en-US": "Start TiboTattle at login (you can change this later in Settings)",
    "zh-Hans": "登录时启动 TiboTattle（稍后可在“设置”中更改）",
    "es": "Iniciar TiboTattle al iniciar sesión (puedes cambiarlo después en Configuración)",
  }),
  "electron.firstRun.continue": Object.freeze({
    "en-US": "Continue",
    "zh-Hans": "继续",
    "es": "Continuar",
  }),
  "electron.firstRun.detail": Object.freeze({
    "en-US": "Reads: timestamps, model and speed labels, token counters, tool categories, and quota snapshots from the selected Codex sessions folders.\n\nStores: content-free indexes, cached calculations, settings, and any prepared contribution in your owner-only TiboTattle app-data folder.\n\nLocal analysis runs on this computer. Fresh installations enable community sharing without sign-in. Existing installations without a saved choice receive three notices before automatic activation. You can turn sharing off persistently in Settings; an explicit earlier opt-out stays off. Uploads are not available in this build.\n\nLocal allowance notifications are off by default. Supported packaged builds can deliver a local alert after fresh provider-reported evidence crosses a selected threshold. This development build cannot deliver OS alerts until it has a supported app identity; TiboTattle does not add background polling.\n\nUpdates: this development build does not include update checks. Signed production releases can check for updates from About.\n\nNever contributed: prompts, responses, file paths, repositories, commands, credentials, emails, or account names.\n\nKeep the app open while analysis runs. You may close and reopen the TiboTattle window; quitting the app stops the current pass and preserves completed checkpoints.\n\nBy default, first-run setup preselects Start TiboTattle at login. TiboTattle adds an operating-system login item only after you click Continue; it uses no daemon, privileged helper, or hidden persistent process.\n\nContinue to start the local dashboard, or Quit to leave the app closed.",
    "zh-Hans": "读取：从选定的 Codex 会话文件夹读取时间戳、模型和速度标签、Token 数量、工具类别以及配额快照。\n\n存储：在仅限你本人访问的 TiboTattle 应用数据文件夹中存储不含会话内容的索引、缓存的计算结果、设置以及已准备的共享数据。\n\n本地分析在此电脑上运行。新安装默认开启社区共享，无需登录。尚未保存共享选择的现有安装会在自动开启前收到三次提示。你可以在“设置”中关闭共享，关闭状态会持续保留；此前明确关闭过共享的安装不会自动开启。此版本暂不支持上传。\n\n本地配额提醒默认关闭。支持的已打包版本可以在提供商报告的最新证据显示用量超过所选阈值后发送本地提醒。此开发版本尚未具备受支持的应用身份，因此无法发送系统提醒；TiboTattle 不会添加后台轮询。\n\n更新：此开发版本不包含更新检查。已签名的生产版本可以从“关于”中检查更新。\n\n绝不共享：提示、回复、文件路径、代码仓库、命令、凭据、电子邮件或账户名称。\n\n分析运行期间请保持应用打开。你可以关闭并重新打开 TiboTattle 窗口；退出应用会停止当前分析，并保留已完成的检查点。\n\n首次设置默认勾选“登录时启动 TiboTattle”。只有在你点击“继续”后，TiboTattle 才会添加操作系统登录项；它不会使用守护进程、特权帮助程序或隐藏的常驻进程。\n\n点击“继续”启动本地用量面板，或点击“退出”关闭应用。",
    "es": "Lee: marcas de tiempo, etiquetas de modelo y velocidad, contadores de tokens, categorías de herramientas y capturas de cuotas de las carpetas de sesiones de Codex seleccionadas.\n\nGuarda: índices sin contenido, cálculos en caché, configuración y cualquier contribución preparada en la carpeta de datos de la aplicación TiboTattle, protegida para tu usuario.\n\nEl análisis local se ejecuta en este equipo. Las instalaciones nuevas activan la compartición comunitaria sin iniciar sesión. Las instalaciones existentes sin una elección guardada reciben tres avisos antes de la activación automática. Puedes desactivar la compartición de forma persistente en Configuración; una desactivación explícita anterior se conserva. Las cargas no están disponibles en esta compilación.\n\nLas notificaciones locales de cuota están desactivadas de forma predeterminada. Las versiones empaquetadas compatibles pueden enviar una alerta local después de que evidencia reciente informada por el proveedor supere el umbral seleccionado. Esta compilación de desarrollo no puede enviar alertas del sistema hasta tener una identidad de aplicación compatible; TiboTattle no añade sondeo en segundo plano.\n\nActualizaciones: esta compilación de desarrollo no incluye comprobaciones de actualización. Las versiones de producción firmadas pueden comprobar actualizaciones desde Acerca de.\n\nNunca se contribuye: indicaciones, respuestas, rutas de archivos, repositorios, comandos, credenciales, correos electrónicos ni nombres de cuenta.\n\nMantén la aplicación abierta mientras se ejecuta el análisis. Puedes cerrar y volver a abrir la ventana de TiboTattle; salir de la aplicación detiene el análisis actual y conserva los puntos de control completados.\n\nDe forma predeterminada, la configuración inicial preselecciona Iniciar TiboTattle al iniciar sesión. TiboTattle añade un elemento de inicio del sistema operativo solo después de que hagas clic en Continuar; no usa demonios, asistentes privilegiados ni procesos persistentes ocultos.\n\nElige Continuar para iniciar el panel local o Salir para dejar la aplicación cerrada.",
  }),
  "electron.firstRun.failure.detail": Object.freeze({
    "en-US": "Review the application data directory and try again. No local companion or login item was started.",
    "zh-Hans": "请检查应用数据文件夹后重试。本地辅助服务和登录项均未启动。",
    "es": "Revisa el directorio de datos de la aplicación e inténtalo de nuevo. No se inició el servicio auxiliar local ni el elemento de inicio.",
  }),
  "electron.firstRun.failure.message": Object.freeze({
    "en-US": "TiboTattle could not verify its local privacy acknowledgement, so it did not start the companion.",
    "zh-Hans": "TiboTattle 无法验证保存在本地的隐私确认记录，因此未启动辅助服务。",
    "es": "TiboTattle no pudo verificar su confirmación de privacidad local, por lo que no inició el servicio auxiliar.",
  }),
  "electron.firstRun.failure.title": Object.freeze({
    "en-US": "TiboTattle cannot start safely",
    "zh-Hans": "TiboTattle 无法安全启动",
    "es": "TiboTattle no puede iniciarse de forma segura",
  }),
  "electron.firstRun.loginRegistration.continue": Object.freeze({
    "en-US": "Continue",
    "zh-Hans": "继续",
    "es": "Continuar",
  }),
  "electron.firstRun.loginRegistration.detail": Object.freeze({
    "en-US": "TiboTattle will continue starting now. You can review or approve this setting in Login Items.",
    "zh-Hans": "TiboTattle 将继续启动。你可以在系统的“登录项”设置中查看或批准此设置。",
    "es": "TiboTattle continuará iniciándose ahora. Puedes revisar o aprobar esta configuración en Elementos de inicio.",
  }),
  "electron.firstRun.loginRegistration.message": Object.freeze({
    "en-US": "The operating system did not confirm Start at login.",
    "zh-Hans": "操作系统尚未确认“登录时启动”设置。",
    "es": "El sistema operativo no confirmó el inicio de sesión automático.",
  }),
  "electron.firstRun.loginRegistration.openSettings": Object.freeze({
    "en-US": "Open Login Items Settings",
    "zh-Hans": "打开登录项设置",
    "es": "Abrir configuración de elementos de inicio",
  }),
  "electron.firstRun.loginRegistration.title": Object.freeze({
    "en-US": "TiboTattle will continue without Start at login",
    "zh-Hans": "TiboTattle 将继续启动，但不会在登录时启动",
    "es": "TiboTattle continuará sin iniciarse al iniciar sesión",
  }),
  "electron.firstRun.message": Object.freeze({
    "en-US": "TiboTattle updates local Codex metadata while the app is open. The first pass starts after setup; later checks reuse the same bounded local companion.",
    "zh-Hans": "TiboTattle 会在应用打开期间更新本地 Codex 元数据。首次分析将在设置完成后开始，后续检查会继续使用同一个运行范围受限的本地辅助服务。",
    "es": "TiboTattle actualiza los metadatos locales de Codex mientras la aplicación está abierta. El primer análisis comienza después de la configuración; las comprobaciones posteriores reutilizan el mismo servicio auxiliar local acotado.",
  }),
  "electron.firstRun.production.detail": Object.freeze({
    "en-US": "TiboTattle reads local usage metadata: timestamps, models, token counts, tool categories and quota snapshots. Analysis and your saved history stay on this computer and work offline.\n\nCommunity sharing sends content-free usage and quota records without sign-in. Fresh installations share automatically. Existing installations without a saved choice receive three notices before sharing begins. Turn sharing off at any time in Settings or Community; an earlier explicit opt-out stays off.\n\nPrompts, responses, file paths, repositories, commands, credentials, emails and account names are never contributed.\n\nUpdate checks are available in About. Manage automatic downloads, optional local notifications and startup in Settings.\n\nKeep TiboTattle open while analysis runs. Quitting stops the current pass and preserves completed checkpoints. The startup checkbox below adds a login item only after you click Continue.",
    "zh-Hans": "TiboTattle 读取本地用量元数据：时间戳、模型、Token 数量、工具类别和配额快照。分析和已保存的历史记录保留在此电脑上，离线也可使用。\n\n社区共享无需登录，会发送不含会话内容的用量和配额记录。新安装会自动共享。尚未保存共享选择的现有安装会在开始共享前收到三次提示。你可以随时在“设置”或“社区”中关闭共享；以前明确关闭的选择会保留。\n\n提示、回复、文件路径、代码仓库、命令、凭据、电子邮件和账户名称绝不会被共享。\n\n你可以在“关于”中检查更新，在“设置”中管理自动下载、可选的本地提醒和启动选项。\n\n分析期间请保持 TiboTattle 打开。退出会停止当前分析，并保留已完成的检查点。只有勾选下方的启动选项并点击“继续”后，应用才会添加系统登录项。",
    "es": "TiboTattle lee metadatos de uso locales: marcas de tiempo, modelos, contadores de tokens, categorías de herramientas y capturas de cuotas. El análisis y tu historial guardado permanecen en este equipo y funcionan sin conexión.\n\nLa compartición comunitaria envía registros de uso y cuotas sin contenido y sin iniciar sesión. Las instalaciones nuevas comparten automáticamente. Las instalaciones existentes sin una elección guardada reciben tres avisos antes de empezar a compartir. Puedes desactivar la compartición en cualquier momento en Configuración o Comunidad; una desactivación explícita anterior se conserva.\n\nNunca se contribuyen instrucciones, respuestas, rutas de archivos, repositorios, comandos, credenciales, correos electrónicos ni nombres de cuenta.\n\nPuedes buscar actualizaciones en Acerca de. Gestiona las descargas automáticas, las notificaciones locales opcionales y el inicio en Configuración.\n\nMantén TiboTattle abierto durante el análisis. Salir detiene el análisis actual y conserva los puntos de control completados. La casilla de inicio que aparece abajo añade un elemento de inicio de sesión solo después de pulsar Continuar.",
  }),
  "electron.firstRun.production.message": Object.freeze({
    "en-US": "See your Codex usage and allowance in one place.",
    "zh-Hans": "集中查看你的 Codex 用量和额度。",
    "es": "Consulta tu uso y tu cuota de Codex en un solo lugar.",
  }),
  "electron.firstRun.production.title": Object.freeze({
    "en-US": "Welcome to TiboTattle",
    "zh-Hans": "欢迎使用 TiboTattle",
    "es": "Te damos la bienvenida a TiboTattle",
  }),
  "electron.firstRun.quit": Object.freeze({
    "en-US": "Quit",
    "zh-Hans": "退出",
    "es": "Salir",
  }),
  "electron.firstRun.title": Object.freeze({
    "en-US": "TiboTattle local data",
    "zh-Hans": "TiboTattle 本地数据",
    "es": "Datos locales de TiboTattle",
  }),
  "electron.menu.accounting": Object.freeze({
    "en-US": "Usage and Costs",
    "zh-Hans": "用量与成本",
    "es": "Uso y costos",
  }),
  "electron.menu.projects": Object.freeze({
    "en-US": "Projects and Threads",
    "zh-Hans": "项目与会话",
    "es": "Proyectos e hilos",
  }),
  "electron.menu.timeline": Object.freeze({
    "en-US": "Usage Timeline",
    "zh-Hans": "用量时间线",
    "es": "Cronología de uso",
  }),
  "electron.menu.toggleSidebar": Object.freeze({
    "en-US": "Toggle Sidebar",
    "zh-Hans": "显示或隐藏侧边栏",
    "es": "Alternar barra lateral",
  }),
  "electron.menu.weekly": Object.freeze({
    "en-US": "Weekly Allowance",
    "zh-Hans": "每周配额",
    "es": "Asignación semanal",
  }),
  "electron.notification.reset.body": Object.freeze({
    "en-US": "Fresh provider-reported quota evidence shows that the window has reset.",
    "zh-Hans": "提供商报告的最新配额证据显示，此配额周期已重置。",
    "es": "La evidencia reciente de cuota informada por el proveedor muestra que la ventana se reinició.",
  }),
  "electron.notification.reset.title": Object.freeze({
    "en-US": "Quota reset observed",
    "zh-Hans": "检测到配额重置",
    "es": "Se observó un reinicio de la cuota",
  }),
  "electron.notification.test.body": Object.freeze({
    "en-US": "This is a local notification test. Your alert settings and usage history have not changed.",
    "zh-Hans": "这是一条本地测试通知。提醒设置和用量历史均未改变。",
    "es": "Esta es una prueba de notificación local. La configuración de alertas y el historial de uso no han cambiado.",
  }),
  "electron.notification.test.title": Object.freeze({
    "en-US": "TiboTattle test notification",
    "zh-Hans": "TiboTattle 测试通知",
    "es": "Notificación de prueba de TiboTattle",
  }),
  "electron.notification.threshold80.body": Object.freeze({
    "en-US": "A fresh provider-reported observation crossed the 80% usage threshold.",
    "zh-Hans": "提供商报告的最新观测显示，配额用量已超过 80% 的提醒阈值。",
    "es": "Una observación reciente informada por el proveedor superó el umbral de uso del 80 %.",
  }),
  "electron.notification.threshold80.title": Object.freeze({
    "en-US": "Quota usage reached 80%",
    "zh-Hans": "配额使用量已达到 80%",
    "es": "El uso de la cuota alcanzó el 80 %",
  }),
  "electron.notification.threshold90.body": Object.freeze({
    "en-US": "A fresh provider-reported observation crossed the 90% usage threshold.",
    "zh-Hans": "提供商报告的最新观测显示，配额用量已超过 90% 的提醒阈值。",
    "es": "Una observación reciente informada por el proveedor superó el umbral de uso del 90 %.",
  }),
  "electron.notification.threshold90.title": Object.freeze({
    "en-US": "Quota usage reached 90%",
    "zh-Hans": "配额使用量已达到 90%",
    "es": "El uso de la cuota alcanzó el 90 %",
  }),
  "electron.recovery.companionBusy.detail": Object.freeze({
    "en-US": "The local usage service is already being restarted.",
    "zh-Hans": "本地用量统计服务正在重启。",
    "es": "El servicio de uso local ya se está reiniciando.",
  }),
  "electron.recovery.companionBusy.title": Object.freeze({
    "en-US": "TiboTattle is busy",
    "zh-Hans": "TiboTattle 正忙",
    "es": "TiboTattle está ocupado",
  }),
  "electron.recovery.companionExitBeforeReady.detail": Object.freeze({
    "en-US": "The local usage service stopped before it became ready.",
    "zh-Hans": "本地用量统计服务尚未启动完成就已停止。",
    "es": "El servicio de uso local se detuvo antes de estar listo.",
  }),
  "electron.recovery.companionExitBeforeReady.title": Object.freeze({
    "en-US": "TiboTattle stopped during startup",
    "zh-Hans": "TiboTattle 启动中途停止",
    "es": "TiboTattle se detuvo durante el inicio",
  }),
  "electron.recovery.companionReadyInvalid.detail": Object.freeze({
    "en-US": "The local usage service returned an invalid startup signal.",
    "zh-Hans": "本地用量统计服务返回的启动信号无效。",
    "es": "El servicio de uso local devolvió una señal de inicio no válida.",
  }),
  "electron.recovery.companionReadyInvalid.title": Object.freeze({
    "en-US": "TiboTattle could not start",
    "zh-Hans": "TiboTattle 无法启动",
    "es": "No se pudo iniciar TiboTattle",
  }),
  "electron.recovery.companionReadyOverflow.detail": Object.freeze({
    "en-US": "The local usage service returned an oversized startup signal.",
    "zh-Hans": "本地用量统计服务返回的启动信号超出大小限制。",
    "es": "El servicio de uso local devolvió una señal de inicio demasiado grande.",
  }),
  "electron.recovery.companionReadyOverflow.title": Object.freeze({
    "en-US": "TiboTattle could not start",
    "zh-Hans": "TiboTattle 无法启动",
    "es": "No se pudo iniciar TiboTattle",
  }),
  "electron.recovery.companionShutdownTimeout.detail": Object.freeze({
    "en-US": "The previous local usage service did not stop in time.",
    "zh-Hans": "上一次运行的本地用量统计服务未能及时停止。",
    "es": "El servicio de uso local anterior no se detuvo a tiempo.",
  }),
  "electron.recovery.companionShutdownTimeout.title": Object.freeze({
    "en-US": "TiboTattle could not restart",
    "zh-Hans": "TiboTattle 无法重新启动",
    "es": "TiboTattle no pudo reiniciarse",
  }),
  "electron.recovery.companionSpawnFailed.detail": Object.freeze({
    "en-US": "The local usage service could not be started.",
    "zh-Hans": "无法启动本地用量统计服务。",
    "es": "No se pudo iniciar el servicio de uso local.",
  }),
  "electron.recovery.companionSpawnFailed.title": Object.freeze({
    "en-US": "TiboTattle could not start",
    "zh-Hans": "TiboTattle 无法启动",
    "es": "No se pudo iniciar TiboTattle",
  }),
  "electron.recovery.companionStartTimeout.detail": Object.freeze({
    "en-US": "The local usage service did not become ready in time.",
    "zh-Hans": "本地用量统计服务未能在规定时间内启动完成。",
    "es": "El servicio de uso local no estuvo listo a tiempo.",
  }),
  "electron.recovery.companionStartTimeout.title": Object.freeze({
    "en-US": "TiboTattle is taking too long to start",
    "zh-Hans": "TiboTattle 启动时间过长",
    "es": "TiboTattle está tardando demasiado en iniciarse",
  }),
  "electron.recovery.diagnostic": Object.freeze({
    "en-US": "Diagnostic: {code}",
    "zh-Hans": "诊断代码：{code}",
    "es": "Diagnóstico: {code}",
  }),
  "electron.recovery.diagnostics": Object.freeze({
    "en-US": "Diagnostics",
    "zh-Hans": "诊断信息",
    "es": "Diagnósticos",
  }),
  "electron.recovery.quit": Object.freeze({
    "en-US": "Quit",
    "zh-Hans": "退出",
    "es": "Salir",
  }),
  "electron.recovery.retry": Object.freeze({
    "en-US": "Retry",
    "zh-Hans": "重试",
    "es": "Reintentar",
  }),
  "electron.recovery.settings": Object.freeze({
    "en-US": "Settings",
    "zh-Hans": "设置",
    "es": "Configuración",
  }),
  "electron.recovery.settings.cancel": Object.freeze({
    "en-US": "Cancel",
    "zh-Hans": "取消",
    "es": "Cancelar",
  }),
  "electron.recovery.settings.choose": Object.freeze({
    "en-US": "Choose Codex Folder",
    "zh-Hans": "选择 Codex 文件夹",
    "es": "Elegir carpeta de Codex",
  }),
  "electron.recovery.settings.detail": Object.freeze({
    "en-US": "Choose a different Codex folder, use the default folder, or cancel. This recovery dialog does not display folder paths.",
    "zh-Hans": "请选择其他 Codex 文件夹、使用默认文件夹或取消。此恢复对话框不会显示文件夹路径。",
    "es": "Elige otra carpeta de Codex, usa la carpeta predeterminada o cancela. Este diálogo de recuperación no muestra rutas de carpetas.",
  }),
  "electron.recovery.settings.failureDetail": Object.freeze({
    "en-US": "No folder path or internal error is shown here. Retry startup or quit and try again.",
    "zh-Hans": "此处不会显示文件夹路径或内部错误。请重试启动，或退出后再试。",
    "es": "Aquí no se muestran rutas de carpetas ni errores internos. Reintenta el inicio o sal y vuelve a intentarlo.",
  }),
  "electron.recovery.settings.failureMessage": Object.freeze({
    "en-US": "TiboTattle could not apply that folder choice.",
    "zh-Hans": "TiboTattle 无法应用所选文件夹。",
    "es": "TiboTattle no pudo aplicar esa elección de carpeta.",
  }),
  "electron.recovery.settings.failureTitle": Object.freeze({
    "en-US": "Codex folder could not be changed",
    "zh-Hans": "无法更改 Codex 文件夹",
    "es": "No se pudo cambiar la carpeta de Codex",
  }),
  "electron.recovery.settings.message": Object.freeze({
    "en-US": "TiboTattle could not start with the configured Codex folder.",
    "zh-Hans": "TiboTattle 无法使用当前配置的 Codex 文件夹启动。",
    "es": "TiboTattle no pudo iniciarse con la carpeta de Codex configurada.",
  }),
  "electron.recovery.settings.title": Object.freeze({
    "en-US": "Repair Codex folder",
    "zh-Hans": "修复 Codex 文件夹",
    "es": "Reparar la carpeta de Codex",
  }),
  "electron.recovery.settings.useDefault": Object.freeze({
    "en-US": "Use Default Folder",
    "zh-Hans": "使用默认文件夹",
    "es": "Usar carpeta predeterminada",
  }),
  "electron.recovery.starting.detail": Object.freeze({
    "en-US": "Starting the local usage service…",
    "zh-Hans": "正在启动本地用量统计服务…",
    "es": "Iniciando el servicio de uso local…",
  }),
  "electron.recovery.starting.title": Object.freeze({
    "en-US": "Starting TiboTattle",
    "zh-Hans": "正在启动 TiboTattle",
    "es": "Iniciando TiboTattle",
  }),
  "electron.recovery.windowTitle": Object.freeze({
    "en-US": "TiboTattle",
    "zh-Hans": "TiboTattle",
    "es": "TiboTattle",
  }),
  "electron.settings.updates.automaticUnavailable": Object.freeze({
    "en-US": "Automatic updates are unavailable in this development build.",
    "zh-Hans": "此开发版本不支持自动更新。",
    "es": "Las actualizaciones automáticas no están disponibles en esta compilación de desarrollo.",
  }),
  "electron.tray.accounting": Object.freeze({
    "en-US": "Usage and Costs",
    "zh-Hans": "用量与成本",
    "es": "Uso y costos",
  }),
  "electron.tray.allowanceFiveHour": Object.freeze({
    "en-US": "Five-hour allowance: {remainingPercent}% remaining",
    "zh-Hans": "五小时配额：剩余 {remainingPercent}%",
    "es": "Cuota de cinco horas: queda un {remainingPercent}%",
  }),
  "electron.tray.allowanceSevenDay": Object.freeze({
    "en-US": "Seven-day allowance: {remainingPercent}% remaining",
    "zh-Hans": "七天配额：剩余 {remainingPercent}%",
    "es": "Cuota de siete días: queda un {remainingPercent}%",
  }),
  "electron.tray.allowanceTitle": Object.freeze({
    "en-US": "{appName} · {allowance} allowance",
    "zh-Hans": "{appName} · 剩余 {allowance}",
    "es": "{appName} · {allowance} disponible",
  }),
  "electron.tray.checkForUpdates": Object.freeze({
    "en-US": "Check for Updates…",
    "zh-Hans": "检查更新…",
    "es": "Buscar actualizaciones…",
  }),
  "electron.tray.evidenceCurrent": Object.freeze({
    "en-US": "Observed {age} · verified current evidence",
    "zh-Hans": "{age}前观测 · 当前证据已验证",
    "es": "Observado hace {age} · evidencia actual verificada",
  }),
  "electron.tray.evidenceStale": Object.freeze({
    "en-US": "Observed {age} · Stale; refresh for current usage",
    "zh-Hans": "{age}前观测 · 数据已过时，请刷新查看当前用量",
    "es": "Observado hace {age} · Desactualizado; actualiza el uso",
  }),
  "electron.tray.statusAnalyzing": Object.freeze({
    "en-US": "Analyzing",
    "zh-Hans": "正在分析",
    "es": "Analizando",
  }),
  "electron.tray.statusFresh": Object.freeze({
    "en-US": "Fresh",
    "zh-Hans": "最新",
    "es": "Actualizado",
  }),
  "electron.tray.statusStale": Object.freeze({
    "en-US": "Stale",
    "zh-Hans": "已过时",
    "es": "Desactualizado",
  }),
  "electron.tray.statusStarting": Object.freeze({
    "en-US": "Starting",
    "zh-Hans": "正在启动",
    "es": "Iniciando",
  }),
  "electron.tray.timeline": Object.freeze({
    "en-US": "Usage Timeline",
    "zh-Hans": "用量时间线",
    "es": "Cronología de uso",
  }),
  "electron.tray.weekly": Object.freeze({
    "en-US": "Weekly Allowance",
    "zh-Hans": "每周配额",
    "es": "Asignación semanal",
  }),
  "electron.tray.windowFiveHour": Object.freeze({
    "en-US": "Five-hour allowance: {remainingPercent}% remaining · resets in {reset}",
    "zh-Hans": "五小时配额：剩余 {remainingPercent}% · {reset} 后重置",
    "es": "Cuota de cinco horas: queda {remainingPercent}% · se reinicia en {reset}",
  }),
  "electron.tray.windowSevenDay": Object.freeze({
    "en-US": "Seven-day allowance: {elapsedPercent}% elapsed · {usedPercent}% used · resets in {reset}",
    "zh-Hans": "七天配额：已过 {elapsedPercent}% · 已用 {usedPercent}% · {reset} 后重置",
    "es": "Cuota de siete días: {elapsedPercent}% transcurrido · {usedPercent}% usado · se reinicia en {reset}",
  }),
  "electron.trayPopover.compactLabel": Object.freeze({
    "en-US": "Allowance remaining",
    "zh-Hans": "剩余配额",
    "es": "Asignación restante",
  }),
  "electron.trayPopover.dashboardHint": Object.freeze({
    "en-US": "Open the dashboard for weekly pace and detailed retained history.",
    "zh-Hans": "打开用量面板，查看每周使用进度和已保存的详细历史记录。",
    "es": "Abre el panel para ver el ritmo semanal y el historial detallado conservado.",
  }),
  "electron.trayPopover.noEvidence": Object.freeze({
    "en-US": "No current allowance evidence is available.",
    "zh-Hans": "暂无可用的当前配额证据。",
    "es": "No hay evidencia actual de asignación disponible.",
  }),
  "electron.trayPopover.title": Object.freeze({
    "en-US": "{appName} usage overview",
    "zh-Hans": "{appName} 用量概览",
    "es": "Resumen de uso de {appName}",
  }),
  "electron.trayPopover.windowsLabel": Object.freeze({
    "en-US": "Allowance windows",
    "zh-Hans": "配额窗口",
    "es": "Ventanas de asignación",
  }),
});

export const DESKTOP_OVERRIDES = Object.freeze({
  // The native menu names the local refresh action more explicitly than the
  // shared compact button label.
  "electron.menu.refresh": Object.freeze({
    "en-US": "Update Local Usage",
    "zh-Hans": "更新本地用量",
    "es": "Actualizar uso local",
  }),
  // The native folder picker uses an imperative window title.
  "electron.settings.codexFolder.title": Object.freeze({
    "en-US": "Choose Codex folder",
    "zh-Hans": "选择 Codex 文件夹",
    "es": "Elegir carpeta de Codex",
  }),
  // This confirms the folder currently shown instead of restoring the default.
  "electron.settings.codexFolder.useDefault": Object.freeze({
    "en-US": "Use this folder",
    "zh-Hans": "使用此文件夹",
    "es": "Usar esta carpeta",
  }),
});
