#!/usr/bin/env node
/**
 * KOOK 派单平台 · 回填 Claude 人工识别结果。
 *
 * 用法：node answer.mjs <id> < 结果JSON
 *   结果格式：{"is_order":true,"game":"","requirement":"","headcount":1,"play_time":"","notes":""}
 * 平台会按与大模型输出相同的规则校验后再写进订单。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './recognize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const queueDir = process.env.RECOGNIZE_QUEUE_DIR || join(here, 'data', 'recognize');
const id = process.argv[2];
const fail = (message) => { console.error(`未回填：${message}`); process.exit(1); };

if (!id || !/^[\w-]+$/.test(id)) fail('缺少或不合法的 id');
if (!existsSync(join(queueDir, 'pending', `${id}.json`))) fail(`找不到待识别的 ${id}（可能已超时）`);
let raw;
try { raw = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('标准输入不是合法 JSON'); }
const result = validate(raw);
const target = join(queueDir, 'answers', `${id}.json`);
writeFileSync(`${target}.tmp`, JSON.stringify(result), 'utf8');
renameSync(`${target}.tmp`, target);
console.log(`已回填：${JSON.stringify(result)}`);
