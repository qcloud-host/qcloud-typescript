import QCloud from '../dist/index.js';
const client = new QCloud();
console.log((await client.models.list()).data.map(model => model.id));
const model = process.env.QCLOUD_MODEL;
if (!model) throw new Error('Set QCLOUD_MODEL to an active catalog ID');
const stream = await client.chat.completions.create({
  model, messages: [{role:'user', content:'Say hello in one sentence.'}], stream:true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta.content ?? '');
