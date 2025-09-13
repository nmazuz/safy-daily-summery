#!/usr/bin/env node
/* eslint-disable no-console */
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';

// Load environment variables from .env file
dotenv.config();

// ====== Config ======
const DB_PATH = process.env.DB_PATH || './data.db';
const ANALYSIS_ENDPOINT = process.env.ANALYSIS_ENDPOINT;
const ANALYSIS_API_KEY = process.env.ANALYSIS_API_KEY;
const TZ = 'Asia/Jerusalem';

if (!ANALYSIS_ENDPOINT) {
  console.error('Missing ANALYSIS_ENDPOINT env var');
  process.exit(1);
}

// ====== Helpers ======
function startEndOfTodaySeconds(tz) {
  const start = DateTime.now().setZone(tz).startOf('day');
  const end = start.plus({ days: 1 }).minus({ seconds: 1 });
  return {
    startSec: Math.floor(start.toSeconds()),
    endSec: Math.floor(end.toSeconds()),
    startMs: start.toMillis(),
    endMs: end.toMillis(),
    isoDate: start.toISODate(),
  };
}

// Very simple PII redaction for message_text
function redactPII(text = '') {
  if (!text) return text;
  return text
    // URLs
    .replace(/\bhttps?:\/\/[^\s]+/gi, '[LINK]')
    .replace(/\bwww\.[^\s]+/gi, '[LINK]')
    // Emails
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    // Phone-like numbers (Israel + general)
    .replace(/\b(?:\+?972[-\s]?\d{1,2}[-\s]?\d{3}[-\s]?\d{4}|\+?\d{1,3}[-\s]?\d{1,4}[-\s]?\d{3,4}[-\s]?\d{3,4})\b/g, '[PHONE]');
}

// Normalize ts to seconds for payload (accepts seconds or ms)
function normalizeTsToSeconds(ts) {
  if (ts == null) return null;
  const n = Number(ts);
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

// ====== Main ======
(async function main() {
  const { startSec, endSec, startMs, endMs, isoDate } = startEndOfTodaySeconds(TZ);

  const db = new Database(DB_PATH, { readonly: true });

  // Pull today’s messages joined with analysis
  // - Prefer analysis.message_text, fallback to messages.text
  // - Filter by messages.ts in today (handles sec or ms)
  // - Exclude deleted messages
  const sql = `
    SELECT
      m.conv_id,
      COALESCE(a.message_text, m.text) AS message_text,
      a.is_offensive AS is_offensive,
      a.offense_type AS offense_type,
      m.modality AS modality,
      m.is_group AS is_group,
      m.ts AS ts
    FROM analysis a
    JOIN messages m ON a.message_id = m.id
    WHERE
      m.deleted_at IS NULL
      AND (
        (m.ts BETWEEN @startSec AND @endSec)  -- ts in seconds
        OR
        (m.ts BETWEEN @startMs AND @endMs)    -- ts in milliseconds
      )
    ORDER BY m.conv_id, m.ts ASC
  `;

  const stmt = db.prepare(sql);
  const rows = stmt.all({ startSec, endSec, startMs, endMs });

  // Group by conv_id and build minimal, PII-redacted payload
  const byConv = new Map();
  for (const r of rows) {
    const key = r.conv_id || 'unknown';
    const arr = byConv.get(key) || [];
    arr.push({
      message_text: redactPII(r.message_text),
      is_offensive: !!r.is_offensive,
      offense_type: r.offense_type || '',
      modality: r.modality,           // 'text' | 'image' | 'audio'
      is_group: !!r.is_group,
      ts: normalizeTsToSeconds(r.ts), // number (seconds)
    });
    byConv.set(key, arr);
  }

  if (byConv.size === 0) {
    console.log(`[${isoDate}] No messages for today in timezone ${TZ}.`);
    process.exit(0);
  }

  // Send per-conversation payloads
  const results = [];
  for (const [conv_id, messages] of byConv.entries()) {
    const payload = {
      conv_id,
      date_tz: TZ,
      date_iso: isoDate,
      messages, // array of { message_text, is_offensive, offense_type, modality, is_group, ts }
    };

    try {
      const res = await fetch(ANALYSIS_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ANALYSIS_API_KEY ? { authorization: `Bearer ${ANALYSIS_API_KEY}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${txt}`);
      }

      // Get the response content from the analysis service
      const responseText = await res.text().catch(() => '');
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      results.push({ conv_id, status: 'ok', response: responseData });
      console.log(`Sent ${messages.length} messages for conv_id=${conv_id}`);
      console.log('Analysis service response:', JSON.stringify(responseData, null, 2));

    } catch (err) {
      results.push({ conv_id, status: 'error', error: String(err) });
      console.error(`Failed conv_id=${conv_id}:`, err);
    }
  }

  // Optional: exit non-zero if any failed
  const failures = results.filter(r => r.status !== 'ok');
  if (failures.length) {
    console.error(`Completed with ${failures.length} failed conversation(s).`);
    process.exit(2);
  } else {
    console.log('All conversations sent successfully.');
  }
})();
