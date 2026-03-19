#!/usr/bin/env node
// donna-podcast-curator.js v2 — YouTube audio + curated podcast feeds
// Uses yt-dlp for reliable video listing (YouTube RSS is flaky)
//
// Usage:
//   node curator.js --youtube          Check for new videos from all channels
//   node curator.js --backfill         Backfill all videos from all channels
//   node curator.js --add-source URL   Add a podcast source to curate from
//   node curator.js --add-episode ID   Add specific episode to curated feed
//   node curator.js --publish          Generate feeds and push to GitHub Pages
//   node curator.js --all              youtube + publish (daily use)
//   node curator.js --backfill-all     backfill + publish (first time setup)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = '/Users/donna/donna-podcasts';
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const FEEDS_DIR = path.join(BASE_DIR, 'feeds');
const AUDIO_DIR = path.join(BASE_DIR, 'audio');
const CURATED_EPISODES_FILE = path.join(BASE_DIR, 'curated-episodes.json');
const YTDLP = '/opt/homebrew/bin/yt-dlp';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const GH = '/opt/homebrew/bin/gh';

fs.mkdirSync(FEEDS_DIR, { recursive: true });

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function escapeXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── YouTube via yt-dlp ────────────────────────────────────────────

function fetchChannelVideos(channelHandle, limit = 15) {
  try {
    const raw = execSync(
      `${YTDLP} --flat-playlist --print "%(id)s|||%(title)s|||%(upload_date)s|||%(description)s" --playlist-items 1-${limit} "https://www.youtube.com/@${channelHandle}/videos"`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [id, title, uploadDate, desc] = line.split('|||');
      const published = uploadDate
        ? `${uploadDate.slice(0,4)}-${uploadDate.slice(4,6)}-${uploadDate.slice(6,8)}T12:00:00Z`
        : new Date().toISOString();
      return {
        id: id.trim(),
        title: (title || '').trim(),
        published,
        description: (desc || '').slice(0, 500).trim()
      };
    }).filter(e => e.id && e.title);
  } catch (e) {
    console.error(`  yt-dlp failed: ${e.message.split('\n')[0]}`);
    return [];
  }
}

function downloadAudio(videoId, channelDir) {
  const outFile = path.join(channelDir, `${videoId}.m4a`);
  if (fs.existsSync(outFile)) return outFile;
  console.log(`  Downloading: ${videoId}...`);
  try {
    execSync(
      `${YTDLP} -f 'bestaudio[ext=m4a]/bestaudio' --no-playlist -o '${outFile}' 'https://www.youtube.com/watch?v=${videoId}'`,
      { encoding: 'utf-8', timeout: 300000, stdio: 'pipe' }
    );
    return outFile;
  } catch (e) {
    console.error(`  Download failed: ${e.message.split('\n')[0]}`);
    return null;
  }
}

function getFileInfo(filePath) {
  const stats = fs.statSync(filePath);
  let duration = 0;
  try {
    const out = execSync(
      `${FFPROBE} -v error -show_entries format=duration -of csv=p=0 '${filePath}'`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    duration = Math.round(parseFloat(out));
  } catch (e) {}
  return { size: stats.size, duration };
}

function uploadReleaseAsset(channelId, videoId, filePath) {
  const tag = `${channelId}-audio`;
  try {
    try {
      execSync(`${GH} release view ${tag} --repo breaknbad/donna-podcasts`, { stdio: 'pipe' });
    } catch {
      execSync(`${GH} release create ${tag} --title "${channelId} Audio" --notes "Audio files" --repo breaknbad/donna-podcasts`, { stdio: 'pipe' });
    }
    const filename = path.basename(filePath);
    execSync(`${GH} release upload ${tag} '${filePath}' --clobber --repo breaknbad/donna-podcasts`, { stdio: 'pipe', timeout: 300000 });
    return `https://github.com/breaknbad/donna-podcasts/releases/download/${tag}/${filename}`;
  } catch (e) {
    console.error(`  Upload failed: ${e.message.split('\n')[0]}`);
    return null;
  }
}

function getReleaseAssetUrl(channelId, videoId) {
  return `https://github.com/breaknbad/donna-podcasts/releases/download/${channelId}-audio/${videoId}.m4a`;
}

async function processYouTube(config, backfill = false) {
  const ytConfig = config.feeds['youtube-audio'];
  let totalNew = 0;

  for (const channel of ytConfig.channels) {
    console.log(`\nChecking: ${channel.name} (@${channel.youtube_handle})`);
    const channelDir = path.join(AUDIO_DIR, channel.id);
    fs.mkdirSync(channelDir, { recursive: true });

    const metaFile = path.join(channelDir, 'episodes.json');
    let episodes = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf-8')) : [];
    const existingIds = new Set(episodes.map(e => e.id));

    const limit = backfill ? 30 : 5;
    const entries = fetchChannelVideos(channel.youtube_handle, limit);
    const newEntries = entries.filter(e => !existingIds.has(e.id));

    if (newEntries.length === 0) {
      console.log('  No new videos');
      continue;
    }

    console.log(`  ${newEntries.length} new videos`);
    for (const entry of newEntries) {
      console.log(`  Processing: ${entry.title}`);
      const audioPath = downloadAudio(entry.id, channelDir);
      if (audioPath) {
        const { size, duration } = getFileInfo(audioPath);
        console.log(`  Uploading to GitHub release...`);
        const releaseUrl = uploadReleaseAsset(channel.id, entry.id, audioPath);
        episodes.push({
          id: entry.id,
          title: entry.title,
          published: entry.published,
          description: entry.description,
          downloaded: true,
          releaseUrl,
          size,
          duration,
          channel: channel.id,
          channelName: channel.name,
          addedAt: new Date().toISOString(),
        });
        totalNew++;
      }
    }

    fs.writeFileSync(metaFile, JSON.stringify(episodes, null, 2));
  }

  return totalNew;
}

function generateYouTubeFeed(config) {
  const ytConfig = config.feeds['youtube-audio'];
  let allEpisodes = [];

  for (const channel of ytConfig.channels) {
    const metaFile = path.join(AUDIO_DIR, channel.id, 'episodes.json');
    if (!fs.existsSync(metaFile)) continue;
    const episodes = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    allEpisodes = allEpisodes.concat(episodes.map(e => ({
      ...e,
      channelName: e.channelName || channel.name,
      image: channel.image
    })));
  }

  allEpisodes.sort((a, b) => new Date(b.published) - new Date(a.published));

  const coverImage = ytConfig.image || 'https://github.com/breaknbad/donna-podcasts/releases/download/covers/youtube-audio.png';

  const items = allEpisodes.filter(e => e.downloaded).map(e => {
    const audioUrl = e.releaseUrl || getReleaseAssetUrl(e.channel, e.id);
    return `    <item>
      <title>${escapeXml(e.title)}</title>
      <description>${escapeXml(e.channelName + ': ' + e.description)}</description>
      <enclosure url="${escapeXml(audioUrl)}" length="${e.size}" type="audio/mp4"/>
      <guid isPermaLink="false">yt-${e.id}</guid>
      <pubDate>${new Date(e.published).toUTCString()}</pubDate>
      <itunes:duration>${formatDuration(e.duration || 0)}</itunes:duration>
      <itunes:author>${escapeXml(e.channelName)}</itunes:author>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${escapeXml(ytConfig.title)}</title>
    <description>${escapeXml(ytConfig.description)}</description>
    <link>https://github.com/breaknbad/donna-podcasts</link>
    <language>en-us</language>
    <itunes:author>Donna</itunes:author>
    <itunes:image href="${coverImage}"/>
${items}
  </channel>
</rss>`;
}

// ── Curated Feed ──────────────────────────────────────────────────

function fetchPodcastRSS(url) {
  try {
    const xml = execSync(`curl -sL '${url}'`, { encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
    const showTitle = xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || 'Unknown Show';
    const episodes = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
      const item = match[1];
      const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '';
      const description = (item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || '').slice(0, 500);
      const audioUrl = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] || '';
      const size = item.match(/<enclosure[^>]+length="(\d+)"/)?.[1] || '0';
      const type = item.match(/<enclosure[^>]+type="([^"]+)"/)?.[1] || 'audio/mpeg';
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const duration = item.match(/<itunes:duration>(.*?)<\/itunes:duration>/)?.[1] || '';
      const guid = item.match(/<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/)?.[1] || audioUrl;
      if (audioUrl) episodes.push({ title, description, audioUrl, size: parseInt(size), type, pubDate, duration, guid, showTitle });
    }
    return { showTitle, episodes };
  } catch (e) {
    console.error(`  Failed to fetch ${url}: ${e.message.split('\n')[0]}`);
    return { showTitle: '', episodes: [] };
  }
}

function loadCuratedEpisodes() {
  return fs.existsSync(CURATED_EPISODES_FILE) ? JSON.parse(fs.readFileSync(CURATED_EPISODES_FILE, 'utf-8')) : [];
}

function saveCuratedEpisodes(episodes) {
  fs.writeFileSync(CURATED_EPISODES_FILE, JSON.stringify(episodes, null, 2));
}

function addSource(rssUrl) {
  const config = loadConfig();
  if (config.feeds.curated.sources.find(s => s.rss === rssUrl)) return console.log('Already tracking');
  console.log(`Fetching: ${rssUrl}`);
  const { showTitle } = fetchPodcastRSS(rssUrl);
  config.feeds.curated.sources.push({ name: showTitle, rss: rssUrl, addedAt: new Date().toISOString() });
  saveConfig(config);
  console.log(`Added source: ${showTitle}`);
}

function addEpisodeById(episodeGuid) {
  const config = loadConfig();
  const curated = loadCuratedEpisodes();
  for (const source of config.feeds.curated.sources) {
    const { episodes } = fetchPodcastRSS(source.rss);
    const ep = episodes.find(e => e.guid === episodeGuid || e.title.toLowerCase().includes(episodeGuid.toLowerCase()));
    if (ep) {
      if (curated.find(c => c.guid === ep.guid)) return console.log(`Already in feed: ${ep.title}`);
      curated.push({ ...ep, curatedAt: new Date().toISOString(), source: source.name });
      saveCuratedEpisodes(curated);
      return console.log(`Added: ${ep.title} (from ${source.name})`);
    }
  }
  console.log(`Episode not found: ${episodeGuid}`);
}

function generateCuratedFeed(config) {
  const curated = loadCuratedEpisodes();
  const curConfig = config.feeds.curated;
  curated.sort((a, b) => new Date(b.curatedAt) - new Date(a.curatedAt));
  const coverImage = curConfig.image || 'https://github.com/breaknbad/donna-podcasts/releases/download/covers/donnas-picks.png';
  const items = curated.map(e => `    <item>
      <title>${escapeXml(e.title)}</title>
      <description>${escapeXml('[' + e.showTitle + '] ' + e.description)}</description>
      <enclosure url="${escapeXml(e.audioUrl)}" length="${e.size}" type="${e.type}"/>
      <guid isPermaLink="false">${escapeXml(e.guid)}</guid>
      <pubDate>${e.pubDate || new Date(e.curatedAt).toUTCString()}</pubDate>
      ${e.duration ? `<itunes:duration>${e.duration}</itunes:duration>` : ''}
      <itunes:author>${escapeXml(e.showTitle)}</itunes:author>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${escapeXml(curConfig.title)}</title>
    <description>${escapeXml(curConfig.description)}</description>
    <link>https://github.com/breaknbad/donna-podcasts</link>
    <language>en-us</language>
    <itunes:author>Donna</itunes:author>
    <itunes:image href="${coverImage}"/>
${items}
  </channel>
</rss>`;
}

// ── Publish ───────────────────────────────────────────────────────

function publish(config) {
  console.log('\nGenerating AI Feed...');
  fs.writeFileSync(path.join(FEEDS_DIR, 'youtube-audio.xml'), generateYouTubeFeed(config));

  console.log('Generating Curated feed...');
  fs.writeFileSync(path.join(FEEDS_DIR, 'curated.xml'), generateCuratedFeed(config));

  console.log('Pushing to GitHub Pages...');
  try {
    execSync('git add feeds/ && git diff --cached --quiet || git commit -m "Update feeds ' + new Date().toISOString().split('T')[0] + '"', {
      cwd: BASE_DIR, encoding: 'utf-8', stdio: 'pipe'
    });
    execSync('git push 2>&1', { cwd: BASE_DIR, encoding: 'utf-8', stdio: 'pipe' });
    console.log('Published!');
  } catch (e) {
    if (e.message.includes('nothing to commit')) console.log('No changes to publish');
    else console.error('Push failed:', e.message.split('\n')[0]);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  if (args.includes('--add-source')) {
    return addSource(args[args.indexOf('--add-source') + 1]);
  }
  if (args.includes('--add-episode')) {
    return addEpisodeById(args[args.indexOf('--add-episode') + 1]);
  }

  const backfill = args.includes('--backfill') || args.includes('--backfill-all');

  if (args.includes('--youtube') || args.includes('--all') || backfill) {
    const newCount = await processYouTube(config, backfill);
    console.log(`\nYouTube: ${newCount} new episodes`);
  }

  if (args.includes('--publish') || args.includes('--all') || args.includes('--backfill-all')) {
    publish(config);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
