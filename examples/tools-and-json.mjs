import QCloud from '../dist/index.js';
const client = new QCloud();
const model = process.env.QCLOUD_MODEL;
if (!model) throw new Error('Select a model supporting tools and JSON output');
const result = await client.chat.completions.create({
  model, messages:[{role:'user',content:'What is the weather in Athens?'}],
  tools: [{"type": "function", "function": {"name": "get_weather", "description": "Look up the weather for a city.", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"], "additionalProperties": false}}}], tool_choice:'auto',
});
// Validate tool arguments before executing your application tools.
console.log(result.choices[0].message.tool_calls);
const structured = await client.chat.completions.create({
  model, messages:[{role:'user',content:'Return a JSON object with a greeting field.'}],
  response_format:{type:'json_object'},
});
console.log(structured.choices[0].message.content);
