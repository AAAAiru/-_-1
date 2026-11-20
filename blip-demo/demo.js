const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));

let report = null;
let imageBase64 = "";
let pendingImage = Promise.resolve();
let attentionViews = null;
let reviewFilter = "all";
let spatialFilter = "improved";

function setImage(file) {
  pendingImage = new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) { reject(new Error('请选择图片文件')); return; }
    if (file.size > 12_000_000) { reject(new Error('图片不能超过 12 MB')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      imageBase64 = String(reader.result);
      $("#image-preview").src = imageBase64;
      $("#image-preview").hidden = false;
      $("#drop-copy").hidden = true;
      $('#live-status').textContent = `已选择 ${file.name}，可以提问。`;
      resolve();
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
  pendingImage.catch((error) => { $('#live-status').textContent = error.message; });
  return pendingImage;
}

$("#image-input").addEventListener("change", (event) => setImage(event.target.files[0]));
const drop = $("#drop-area");
drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("dragover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("dragover");
  setImage(event.dataTransfer.files[0]);
});

$$('.sample').forEach((button) => button.addEventListener('click', async () => {
  if (!report) return;
  const index = {good: 0, medium: 1, bad: 2}[button.dataset.sample];
  const item = report.examples[index];
  const response = await fetch(item.image);
  const blob = await response.blob();
  await setImage(new File([blob], `example-${index}.jpg`, {type: 'image/jpeg'}));
  $('#question-input').value = item.question;
}));

$('#ask-button').addEventListener('click', async () => {
  const question = $('#question-input').value.trim();
  try { await pendingImage; } catch { return; }
  if (!imageBase64) { $('#live-status').textContent = '请先上传图片或选择示例图'; return; }
  if (!question) { $('#live-status').textContent = '请输入英文问题'; return; }
  const button = $('#ask-button');
  button.disabled = true;
  button.textContent = '正在生成三项结果…';
  $('#live-status').textContent = 'BLIP 正在回答并生成热图，随后运行开放式模型。';
  $('#answer-text').textContent = '推理中…';
  $('#open-answer-text').textContent = '等待模型…';
  $('#heat-placeholder').textContent = '生成热图中…';
  $('#live-heatmap').hidden = true;
  $('#heat-token').disabled = true;
  try {
    throw new Error('在线版提供评测与案例浏览，实时推理请在本机启动模型服务。'); const response = await fetch('/api/analyze', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({image: imageBase64.split(',')[1], question})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '模型运行失败');
    $('#answer-text').textContent = result.blip_answer;
    $('#open-answer-text').textContent = result.open_error ? `开放式模型运行失败：${result.open_error}` : result.open_answer;
    attentionViews = result.attention;
    const picker = $('#heat-token');
    picker.innerHTML = '<option value="all">全部问题词平均</option>' + attentionViews.tokens.map((item, index) => `<option value="${index}">词 ${index + 1}：${esc(item.label)}</option>`).join('');
    picker.value = 'all';
    picker.disabled = false;
    $('#live-heatmap').src = `data:image/png;base64,${attentionViews.all}`;
    $('#live-heatmap').hidden = false;
    $('#heat-placeholder').hidden = true;
    $('#device-label').textContent = `设备 ${result.device}`;
    $('#live-status').textContent = result.open_error ? 'BLIP 和热图已完成；开放式模型运行失败。' : '三项结果已生成。';
  } catch (error) {
    $('#answer-text').textContent = `运行失败：${error.message}`;
    $('#open-answer-text').textContent = '未生成';
    $('#heat-placeholder').textContent = '未生成';
    $('#heat-placeholder').hidden = false;
    $('#live-status').textContent = '运行失败，请检查图片或稍后重试。';
  } finally {
    button.disabled = false;
    button.innerHTML = '同时生成三项结果 <span aria-hidden="true">→</span>';
  }
});

$('#heat-token').addEventListener('change', (event) => {
  if (!attentionViews) return;
  const value = event.target.value;
  const png = value === 'all' ? attentionViews.all : attentionViews.tokens[Number(value)]?.image;
  if (png) $('#live-heatmap').src = `data:image/png;base64,${png}`;
});

function renderSummary() {
  const s = report.summary;
  const percent = (100 * s.base50_correct / s.base50_total).toFixed(1);
  $('#hero-score').innerHTML = `${s.base50_correct}<small>/${s.base50_total}</small>`;
  $('#baseline-percent').innerHTML = `${percent}<small>%</small>`;
  $('#baseline-meter').style.width = `${percent}%`;
  $('#baseline-count').textContent = `${s.base50_correct} / ${s.base50_total}`;
  $('#spatial-base-score').textContent = `${s.spatial_baseline_correct} / ${s.spatial_total}`;
  $('#spatial-crop-score').textContent = `${s.spatial_grounded_correct} / ${s.spatial_total}`;
  $('#improved-count').textContent = s.spatial_improved;
  $('#regressed-count').textContent = s.spatial_regressed;
  const groups = {};
  report.base50.forEach((r) => {
    const name = r.category || '其他';
    groups[name] ??= {total: 0, correct: 0};
    groups[name].total++;
    if (r.manual_correct === '正确') groups[name].correct++;
  });
  $('#category-bars').innerHTML = Object.entries(groups).map(([name, n]) => `
    <div class="category-row"><span>${esc(name)}</span><div class="small-meter"><i style="width:${100*n.correct/n.total}%"></i></div><strong>${n.correct} / ${n.total}</strong></div>`).join('');
}

function renderExamples() {
  const levels = ['good','medium','bad'];
  $('#example-cards').innerHTML = report.examples.map((r, index) => `
    <article class="example"><img src="${esc(r.image)}" alt="${esc(r.level)}例图片" loading="lazy"><div class="example-body">
      <span class="level ${levels[index]}">${esc(r.level)}例</span><h4>${esc(r.question)}</h4>
      <div class="answer-line"><span>BLIP 原回答</span><strong>${esc(r.pipeline_answer)}</strong></div>
      <div class="answer-line"><span>参考答案</span><strong>${esc(r.reference)}</strong></div>
      <p>${esc(r.reason)}</p></div></article>`).join('');
}

function renderReview() {
  const search = $('#review-search').value.trim().toLowerCase();
  const selected = report.base50.filter((r) =>
    (reviewFilter === 'all' || r.manual_correct === '错误') &&
    `${r.question} ${r.reference} ${r.prediction} ${r.category}`.toLowerCase().includes(search));
  $('#review-list').innerHTML = selected.map((r) => `
    <div class="review-row"><span>${String(r.id).padStart(2,'0')}</span><img src="${esc(r.image)}" alt="第${r.id}题图片" loading="lazy">
    <b>${esc(r.question)}</b><span class="review-answer">模型 ${esc(r.prediction)}<br>参考 ${esc(r.reference)}</span>
    <span class="${r.manual_correct === '正确' ? 'correct' : 'wrong'}">${esc(r.manual_correct)}</span></div>`).join('') || '<p style="padding:16px">没有匹配的题目</p>';
}
$$('[data-review-filter]').forEach((button) => button.addEventListener('click', () => {
  reviewFilter = button.dataset.reviewFilter;
  $$('[data-review-filter]').forEach((item) => item.classList.toggle('active', item === button));
  renderReview();
}));
$('#review-search').addEventListener('input', renderReview);

const attentionNotes = {
  '好': '模型正确识别了路缘颜色。亮区显示问题词与图像区域的关联，但并不单独证明模型的判断过程。',
  '中': '模型抓住了游乐场语境，回答较宽泛。热区可以帮助讨论它关注的画面范围。',
  '差': '模型将红色建筑答为 brown，注意力也分散到天空与建筑周边。这里只能提出可能的定位或颜色辨别问题。'
};
function renderAttention(level='好') {
  const item = report.attention.find((x) => x.level === level);
  if (!item) return;
  $('#attention-image').src = item.figure;
  $('#attention-question').textContent = item.question;
  $('#attention-answer').textContent = item.answer;
  $('#attention-reference').textContent = item.reference;
  $('#attention-note').textContent = attentionNotes[level];
  $$('[data-attention]').forEach((button) => {
    const active = button.dataset.attention === level;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}
$$('[data-attention]').forEach((button) => button.addEventListener('click', () => renderAttention(button.dataset.attention)));

function renderErrors() {
  const cases = [
    {question:'How many people are visible in this image?', kind:'视觉计数', detail:'前景模糊且多人遮挡。改问后模型由 8 变为 7，仍未达到人工认可的 6。'},
    {question:'Where are the wings?', kind:'部位与关系', detail:'翅膀画在路牌人物的背部。模型回答 on sign，回答了大场景位置而非人物部位。'},
    {question:'Where do the footprints lead?', kind:'关系理解', detail:'原回答为 water；明确改问“是否通向人物”后模型答 yes，表现出问法敏感。'},
    {question:'What color is the building with the clock on it?', kind:'颜色与目标', detail:'人工认可 red，模型回答 brown。注意力分散，不能单凭热图判断具体成因。'}
  ];
  $('#error-cards').innerHTML = cases.map((item) => {
    const row = report.base50.find((r) => r.question === item.question);
    return `<article class="error-card"><img src="${esc(row.image)}" alt="错误案例图片" loading="lazy"><div class="error-body">
      <span class="error-kind">${esc(item.kind)}</span><h3>${esc(row.question)}</h3>
      <p>模型 <strong>${esc(row.prediction)}</strong> · 人工参考 <b>${esc(row.reference)}</b></p>
      <p>${esc(item.detail)}</p></div></article>`;
  }).join('');
}

function renderSpatial() {
  const selected = report.spatial.filter((r) => spatialFilter === 'improved'
    ? r.baseline_manual === '错误' && r.grounded_manual === '正确'
    : r.baseline_manual === '正确' && r.grounded_manual === '错误');
  $('#spatial-cases').innerHTML = selected.map((r) => `<div class="mini-case"><img src="${esc(r.image)}" alt="第${esc(r.id)}题图片" loading="lazy"><div>
    <b>第 ${esc(r.id)} 题 · ${esc(r.question)}</b><p>${esc(r.baseline)} → ${esc(r.grounded)}</p></div></div>`).join('');
}
$$('[data-spatial]').forEach((button) => button.addEventListener('click', () => {
  spatialFilter = button.dataset.spatial;
  $$('[data-spatial]').forEach((item) => item.classList.toggle('active', item === button));
  renderSpatial();
}));

function renderExperiments() {
  renderSpatial();
  const change = report.finetune_changed;
  $('#finetune-change').textContent = change.length === 1
    ? `第 ${change[0].id} 题：${change[0].before} → ${change[0].after}，语义相同。未观察到实质准确率提升。`
    : `${change.length} 题答案变化；需逐题人工核对。`;
  const methods = [
    {label:'仅问题文字', score:report.encoder.text_only.all_accuracy},
    ...report.encoder.models.map((m) => ({label:m.encoder, score:m.all_accuracy}))
  ];
  $('#encoder-bars').innerHTML = methods.map((m) => `
    <div class="encoder-col"><b>${esc(m.label)}</b><strong>${Math.round(m.score*30)} / 30</strong><div class="small-meter"><i style="width:${m.score*100}%"></i></div></div>`).join('');
}

function renderOpenEnded() {
  $('#open-cards').innerHTML = report.open_ended.map((r) => `
    <article class="open-card"><img src="${esc(r.image)}" alt="开放式问答题图" loading="lazy"><div class="open-body"><h3>${esc(r.question)}</h3>
      <small>BLIP · 原题短答案</small><p><b>${esc(r.blip_answer)}</b></p>
      <small>SmolVLM · 开放式提示</small><p>${esc(r.open_prompt)}</p>
      <small>SmolVLM · 模型原始描述</small><p class="model-response">${esc(r.open_answer)}</p></div></article>`).join('');
}

async function loadReport() {
  try {
    const response = await fetch('./report.json');
    if (!response.ok) throw new Error('无法读取实验数据');
    report = await response.json();
    renderSummary(); renderExamples(); renderReview(); renderAttention(); renderErrors(); renderExperiments(); renderOpenEnded();
  } catch (error) {
    $('#category-bars').textContent = `读取失败：${error.message}。请刷新页面。`;
    $('#review-list').textContent = '暂时无法显示题目清单。';
  }
}
loadReport();
