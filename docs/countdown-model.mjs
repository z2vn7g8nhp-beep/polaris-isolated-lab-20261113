export function releaseTarget(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const utc = Date.parse(value + "T00:00:00Z");
  if (
    !Number.isFinite(utc) ||
    new Date(utc).toISOString().slice(0, 10) !== value
  )
    return null;
  return utc - 8 * 3600000;
}
export function countdownParts(release, at = Date.now()) {
  const target = releaseTarget(release);
  if (target === null)
    return { kind: "undated", days: 0, hours: 0, minutes: 0, seconds: 0 };
  let total = Math.max(0, Math.ceil((target - at) / 1000));
  return {
    kind: target > at ? "pending" : "released",
    days: Math.floor(total / 86400),
    hours: Math.floor(total / 3600) % 24,
    minutes: Math.floor(total / 60) % 60,
    seconds: total % 60,
  };
}
export function countdownMovie(data, choice) {
  const movies = data?.movies || [],
    selected = movies.find((m) => m.id === (choice || data.countdownMovieId));
  if (selected) return selected;
  const dated = movies.filter((m) => {
    const target = releaseTarget(m.release);
    return target !== null && target > Date.now();
  });
  return (
    dated.sort(
      (a, b) =>
        Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
        (b.wish || 0) - (a.wish || 0),
    )[0] || null
  );
}
