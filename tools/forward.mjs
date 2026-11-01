// The page every old ottawaplated.com address becomes: it forwards straight to plated.gallery.
export const NEW = 'https://plated.gallery';
export function forwardPage(target, { keepQuery = false } = {}) {
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ottawa Plated has moved to plated.gallery</title>
<link rel="canonical" href="${target}">
<meta http-equiv="refresh" content="0; url=${target}">
<meta name="theme-color" content="#0b0a08">
<script>location.replace(${JSON.stringify(target)}${keepQuery ? ' + location.search' : ''} + location.hash);</script>
<style>html{background:#0b0a08;color:#ece6d8}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}a{color:inherit}</style>
</head>
<body>
<p>Ottawa Plated is now part of Plated.<br><a href="${target}">Continue to ${target.replace('https://', '')}</a></p>
</body>
</html>
`;
}
