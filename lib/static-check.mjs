const localOrigin = 'http://static-check.invalid'

function references(file, source) {
  if (file.endsWith('.html')) {
    return [...source.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*(["'])([^"']+)\1/gi)].map(match => match[2])
  }
  if (!/\.m?js$/i.test(file)) return []
  const declarations = /^\s*(?:import\s+(?:[^"'();]*?\s+from\s*)?|export\s+(?:\*[^"';]*?|\{[^}]*\})\s*from\s*)(["'])([^"'\n]+)\1/gm
  const lazyImports = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g
  return [...source.matchAll(declarations), ...source.matchAll(lazyImports)].map(match => match[2])
}

export async function checkStaticRoutes(routes, readAsset) {
  const sources = new Map()
  const warnings = []
  for (const [route, [file]] of routes) {
    if (!sources.has(file)) {
      try {
        sources.set(file, await readAsset(file))
      } catch {
        sources.set(file, null)
      }
    }
    if (sources.get(file) === null) warnings.push('登记的静态文件不存在或无法读取：' + route + ' → ' + file)
  }

  const reported = new Set()
  for (const [route, [file]] of routes) {
    for (const specifier of references(file, sources.get(file) ?? '')) {
      if (!/^(?:\.{1,2}\/|\/(?!\/))/.test(specifier)) continue
      const target = new URL(specifier, localOrigin + route).pathname
      const issue = file + ' → ' + target
      if (routes.has(target) || reported.has(issue)) continue
      reported.add(issue)
      warnings.push('页面引用未登记路由：' + issue)
    }
  }
  return warnings
}
