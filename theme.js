const palettes = {
  plum: ['夜幕莓红', '#161319', '#211c25', '#f6edf4', '#c6b7c6', '#f2a5b8', '#9d3958', 'dark'],
  ink: ['深海蓝', '#101721', '#192536', '#eaf3ff', '#b2c4d9', '#8bcaff', '#2e6293', 'dark'],
  moss: ['松间绿', '#121a16', '#1b2921', '#edf4e9', '#b6ccbc', '#a6dfa7', '#376a49', 'dark'],
  paper: ['暖纸白', '#f5eee3', '#fffaf2', '#30251f', '#63564c', '#874235', '#8b493c', 'light'],
  'liquid-glass': ['液态玻璃', '#0b1427', '#182a43', '#f0f7ff', '#c0d4e6', '#a2ebf7', '#9ae8f7', 'dark'],
  claymorphism: ['粘土拟态', '#fff0f8', '#fef3c7', '#3b2845', '#634759', '#92375f', '#f8b4d9', 'light'],
  holographic: ['全息渐变', '#0a0a1f', '#1a0b2e', '#f8f0ff', '#d2bfdf', '#c98bff', '#a855f7', 'dark'],
  neumorphism: ['新拟物派', '#e0e5ec', '#d1d9e6', '#273247', '#47566d', '#5945d8', '#6d5dfc', 'light']
}
const materials = {
  'liquid-glass': { radius: 22, texture: 'glow' },
  claymorphism: { radius: 28, texture: 'glow' },
  holographic: { radius: 20, texture: 'glow' },
  neumorphism: { radius: 20, texture: 'none' }
}
const colorKeys = ['base', 'panel', 'text', 'muted', 'rose', 'red']
const fonts = {
  sans: 'system-ui, "Microsoft YaHei", sans-serif',
  serif: '"Songti SC", "Noto Serif CJK SC", SimSun, Georgia, serif',
  mono: 'ui-monospace, Consolas, "Microsoft YaHei", monospace'
}
const ranges = {
  size: [14, 22, 16],
  radius: [0, 28, 14],
  width: [640, 1280, 960],
  spacing: [70, 140, 100],
  wallpaperDim: [0, 85, 24]
}
const key = 'story-card-editor.theme.v1'
const dialog = document.querySelector('#theme-dialog')
const controls = document.querySelector('#theme-controls')
const status = document.querySelector('#theme-status')
const fields = new Map()
const materialButtons = new Map()
const root = document.documentElement
let saved
let draft

function preset(id) {
  const [, ...values] = palettes[id]
  const material = Object.hasOwn(materials, id) ? id : 'plain'
  return {
    colors: Object.fromEntries(colorKeys.map((name, index) => [name, values[index]])),
    scheme: values[6], font: 'sans', texture: 'grid', material,
    storyColors: 'custom', wallpaper: 'story', wallpaperImage: '',
    ...Object.fromEntries(Object.entries(ranges).map(([name, range]) => [name, range[2]])),
    ...materials[material]
  }
}

function normalize(value) {
  const theme = preset(Object.hasOwn(materials, value?.material) ? value.material : 'plum')
  for (const name of colorKeys) {
    const color = value?.colors?.[name]
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) theme.colors[name] = color
  }
  for (const [name, [min, max]] of Object.entries(ranges)) {
    const number = value?.[name]
    if (Number.isFinite(number)) theme[name] = Math.round(Math.max(min, Math.min(max, number)))
  }
  if (Object.hasOwn(fonts, value?.font)) theme.font = value.font
  if (['light', 'dark'].includes(value?.scheme)) theme.scheme = value.scheme
  if (['grid', 'glow', 'none'].includes(value?.texture)) theme.texture = value.texture
  theme.storyColors = ['story', 'custom'].includes(value?.storyColors)
    ? value.storyColors
    : colorKeys.every((name, i) => theme.colors[name] === palettes.plum[i + 1]) && theme.scheme === 'dark' ? 'story' : 'custom'
  if (typeof value?.wallpaperImage === 'string' && value.wallpaperImage.length <= 500_000
      && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value.wallpaperImage)) {
    theme.wallpaperImage = value.wallpaperImage
  }
  if (value?.wallpaper === 'off' || (value?.wallpaper === 'custom' && theme.wallpaperImage)) theme.wallpaper = value.wallpaper
  return theme
}

function buttonInk(color) {
  const channels = color.slice(1).match(/../g).map(part => parseInt(part, 16) / 255)
  const [r, g, b] = channels.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return .2126 * r + .7152 * g + .0722 * b > .179 ? '#000000' : '#ffffff'
}

function apply(theme) {
  for (const [name, value] of Object.entries(theme.colors)) root.style.setProperty('--' + name, value)
  root.style.setProperty('--button-ink', buttonInk(theme.colors.red))
  root.style.setProperty('--ui-font', fonts[theme.font])
  root.style.setProperty('--ui-size', theme.size + 'px')
  root.style.setProperty('--ui-radius', theme.radius + 'px')
  root.style.setProperty('--ui-width', theme.width + 'px')
  root.style.setProperty('--ui-spacing', theme.spacing / 100)
  root.style.colorScheme = theme.scheme
  root.dataset.texture = theme.texture
  const hasMaterial = theme.material !== 'plain'
  root.dataset.uiTheme = theme.material
  root.dataset.storyColors = hasMaterial ? 'custom' : theme.storyColors
  const storyColors = fields.get('storyColors').input
  storyColors.disabled = hasMaterial
  storyColors.value = root.dataset.storyColors
  for (const [id, button] of materialButtons) button.setAttribute('aria-pressed', String(theme.material === id))
  root.dataset.wallpaper = theme.wallpaper
  root.style.setProperty('--wallpaper-dim', theme.wallpaperDim / 100)
  if (theme.wallpaperImage) root.style.setProperty('--custom-wallpaper', 'url("' + theme.wallpaperImage + '")')
  else root.style.removeProperty('--custom-wallpaper')
}

function field(name, label, input, colors = false) {
  const wrapper = document.createElement('label')
  wrapper.textContent = label
  const value = document.createElement('output')
  value.setAttribute('aria-hidden', 'true')
  wrapper.append(input, value)
  controls.append(wrapper)
  fields.set(name, { input, value, colors })
  input.addEventListener('input', () => {
    const next = input.type === 'range' ? input.valueAsNumber : input.value
    if (colors) {
      draft.colors[name] = next
      draft.storyColors = 'custom'
      fields.get('storyColors').input.value = 'custom'
    } else draft[name] = next
    value.textContent = input.type === 'range' || colors ? next : ''
    apply(draft)
  })
}

function select(name, label, options) {
  const input = document.createElement('select')
  for (const [value, title] of Object.entries(options)) input.add(new Option(title, value))
  field(name, label, input)
}

function refresh() {
  for (const [name, { input, value, colors }] of fields) {
    const current = colors ? draft.colors[name] : draft[name]
    input.value = current
    value.textContent = input.type === 'range' || colors ? current : ''
  }
  fields.get('wallpaper').input.querySelector('[value="custom"]').disabled = !draft.wallpaperImage
  status.textContent = ''
  apply(draft)
}

for (const [id, [label]] of Object.entries(palettes)) {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.preset = id
  button.textContent = label
  button.style.setProperty('--sample', palettes[id][6])
  if (Object.hasOwn(materials, id)) materialButtons.set(id, button)
  button.addEventListener('click', () => {
    draft = { ...preset(id), wallpaper: draft.wallpaper, wallpaperDim: draft.wallpaperDim, wallpaperImage: draft.wallpaperImage }
    refresh()
  })
  document.querySelector('#theme-presets').append(button)
}

for (const [index, label] of ['页面背景', '面板背景', '正文文字', '次要文字', '强调色', '主按钮'].entries()) {
  const input = document.createElement('input')
  input.type = 'color'
  field(colorKeys[index], label, input, true)
}

for (const [name, label] of Object.entries({ size: '字号（px）', radius: '圆角（px）', width: '内容宽度（px）', spacing: '间距（%）', wallpaperDim: '壁纸压暗（%）' })) {
  const input = document.createElement('input')
  input.type = 'range'
  const [min, max] = ranges[name]
  input.min = min
  input.max = max
  field(name, label, input)
}
select('scheme', '系统控件色调', { dark: '深色', light: '浅色' })
select('font', '字体', { sans: '无衬线', serif: '衬线', mono: '等宽' })
select('texture', '背景装饰', { grid: '细网格', glow: '柔光', none: '纯色' })
select('storyColors', '灯塔配色', { story: '剧本默认', custom: '使用自定义配色' })
select('wallpaper', '灯塔壁纸', { story: '剧本壁纸', custom: '已上传壁纸', off: '纯色' })

try {
  saved = normalize(JSON.parse(localStorage.getItem(key)))
} catch {
  saved = normalize(null)
}
apply(saved)

document.querySelector('#theme-open').addEventListener('click', () => {
  draft = structuredClone(saved)
  refresh()
  dialog.showModal()
})
dialog.addEventListener('close', () => apply(saved))
document.querySelector('#theme-form').addEventListener('submit', event => {
  event.preventDefault()
  try {
    localStorage.setItem(key, JSON.stringify(draft))
    saved = structuredClone(draft)
    dialog.close()
  } catch {
    status.textContent = '浏览器无法保存主题，可以先导出 JSON。'
  }
})
document.querySelector('#theme-cancel').addEventListener('click', () => dialog.close())
document.querySelector('#theme-reset').addEventListener('click', () => {
  draft = normalize(null)
  refresh()
})
const file = document.querySelector('#theme-file')
document.querySelector('#theme-import').addEventListener('click', () => file.click())
file.addEventListener('change', async () => {
  const selected = file.files[0]
  file.value = ''
  if (!selected) return
  try {
    if (selected.size > 530_000) throw new Error('主题文件超过 530 KB。')
    const data = JSON.parse((await selected.text()).replace(/^\uFEFF/, ''))
    if (data?.version !== 1 || !data.theme || typeof data.theme !== 'object' || Array.isArray(data.theme)) {
      throw new Error('请选择此编辑器导出的主题 JSON。')
    }
    if (!dialog.open) return
    draft = normalize(data.theme)
    refresh()
    status.textContent = '已载入预览，点「保存主题」应用。'
  } catch (error) {
    if (dialog.open) status.textContent = '导入失败。' + error.message
  }
})

const wallpaperFile = document.querySelector('#wallpaper-file')
document.querySelector('#wallpaper-upload').addEventListener('click', () => wallpaperFile.click())
wallpaperFile.addEventListener('change', async () => {
  const file = wallpaperFile.files[0]
  wallpaperFile.value = ''
  if (!file) return
  const editing = draft
  const url = URL.createObjectURL(file)
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('请选择小于 16 MB 的图片。')
    const image = new Image()
    image.src = url
    await image.decode()
    if (!dialog.open || draft !== editing) return
    const ratio = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const context = canvas.getContext('2d')
    context.fillStyle = '#101b26'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', .76)
    if (data.length > 500_000) throw new Error('压缩后仍然过大，请换一张较小的图片。')
    draft.wallpaperImage = data
    draft.wallpaper = 'custom'
    refresh()
    status.textContent = '壁纸已载入预览，点「保存主题」应用。'
  } catch (error) {
    if (dialog.open && draft === editing) status.textContent = '壁纸加载失败。' + error.message
  } finally {
    URL.revokeObjectURL(url)
  }
})
document.querySelector('#theme-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, theme: draft }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'story-card-theme.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})
