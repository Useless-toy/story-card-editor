const tierRank = role => ({ cast: 0, support: 1, extra: 2 }[role.tier ?? 'cast'])
const names = role => [role.name, ...(role.aliases ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)
const places = value => String(value ?? '').split(/[\/／\n]/).map(x => x.trim()).filter(Boolean)
export const samePlace = (a, b) => places(a).some(x => places(b).some(y => x.includes(y) || y.includes(x)))

/** Roster entries carry remote explicitly: mentioning a person never teleports them. */
export function resolveRoster(roles, { location = '', playerInput = '', lastRoster = [], maxOnStage = 8, alwaysOnStage = [], previousLocation = location } = {}) {
  const previous = lastRoster.map(x => typeof x === 'string' ? { id: x, remote: false } : x)
  const moved = previousLocation !== location
  const candidates = []
  roles.forEach((role, order) => {
    if (role.tier === 'extra') return
    const always = alwaysOnStage.some(x => x === role.id || names(role).includes(x))
    const local = role.where && samePlace(role.where, location)
    const mention = names(role).find(x => String(playerInput).includes(x))
    const last = previous.find(x => x.id === role.id)
    const continued = last && !moved && (!role.where || local)
    if (!always && !local && !mention && !continued) return
    candidates.push({ id: role.id, remote: !always && !local && !(continued && !last.remote), always,
      rank: tierRank(role), score: (local ? 1000 : 0) + (mention?.length ?? 0),
      last: previous.findIndex(x => x.id === role.id), order })
  })
  return candidates.sort((a, b) => Number(b.always) - Number(a.always) || a.rank - b.rank || b.score - a.score ||
    (a.last < 0 ? Infinity : a.last) - (b.last < 0 ? Infinity : b.last) || a.order - b.order)
    .slice(0, maxOnStage).map(({ id, remote }) => ({ id, remote }))
}

export function rosterWarnings(panels, roles, roster) {
  const allowed = new Set(roster.filter(x => typeof x === 'string' || !x.remote).map(x => typeof x === 'string' ? x : x.id))
  const source = panels.map(p => /在场/.test(p.title) ? p.text :
    [...String(p.text).matchAll(/(?:【在场[^】]*】|^在场[：:])([^\n]*)/gm)].map(x => x[1]).join('\n')).join('\n')
  return roles.filter(role => !allowed.has(role.id) && names(role).some(name => source.includes(name)))
    .map(role => '本轮出现了不在场角色：' + role.name)
}
