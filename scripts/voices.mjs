import { readFileSync, writeFileSync } from "node:fs"
const KEY = readFileSync("/home/ssalb/coachskaffur/.env","utf8").match(/GEMINI_API_KEY=(.+)/)[1].trim()
const img = readFileSync(process.argv[2]).toString("base64")
const OUT = process.argv[3]
const LINE = "Two of them are dead — you have about eighteen seconds. Take the drake now, sleepyhead."

/** 24kHz mono 16-bit PCM -> a .wav you can actually double-click. */
const wav = (pcm) => {
  const h = Buffer.alloc(44)
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8); h.write("fmt ",12)
  h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(1,22); h.writeUInt32LE(24000,24)
  h.writeUInt32LE(48000,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write("data",36)
  h.writeUInt32LE(pcm.length,40)
  return Buffer.concat([h,pcm])
}
const run = (voice) => new Promise(async res => {
  const mint = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method:"POST", headers:{"x-goog-api-key":KEY,"content-type":"application/json"}, body:JSON.stringify({uses:1})})
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent((await mint.json()).name)}`)
  const chunks=[]; let text="", done=false
  ws.onopen = () => ws.send(JSON.stringify({ setup:{ model:"models/gemini-3.1-flash-live-preview",
    generationConfig:{ responseModalities:["AUDIO"], speechConfig:{ voiceConfig:{ prebuiltVoiceConfig:{ voiceName: voice } } } },
    outputAudioTranscription:{},
    systemInstruction:{parts:[{text:"You are Lillia, a soft, dreamy League of Legends coach. Repeat the user's line back exactly, once."}]} }}))
  ws.onmessage = async ev => {
    const m = JSON.parse(typeof ev.data==="string"?ev.data:await ev.data.text())
    if (m.setupComplete) {
      ws.send(JSON.stringify({ realtimeInput:{ video:{ mimeType:"image/jpeg", data:img } } }))
      setTimeout(()=>ws.send(JSON.stringify({ clientContent:{ turns:[{role:"user",parts:[{text:`Say exactly this and nothing else: "${LINE}"`}]}], turnComplete:true }})), 700)
      return
    }
    const sc=m.serverContent; if(!sc) return
    if (sc.outputTranscription?.text) text += sc.outputTranscription.text
    for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data,"base64"))
    if (sc.turnComplete) { done=true; ws.close()
      const pcm = Buffer.concat(chunks)
      if (pcm.length) writeFileSync(`${OUT}/${voice}.wav`, wav(pcm))
      res(`${voice.padEnd(14)} ${String(chunks.length).padStart(3)} parts  ${(pcm.length/1024).toFixed(0).padStart(4)} KB  ${(pcm.length/48000).toFixed(1)}s`) }
  }
  ws.onclose = e => { if(!done) res(`${voice.padEnd(14)} CLOSED ${e.code} ${String(e.reason).slice(0,50)}`) }
  setTimeout(()=>{ if(!done){ws.close();res(`${voice.padEnd(14)} timeout`)} },45000)
})
// Google's gentler / younger-sounding prebuilt voices — the plausible Lillia candidates.
for (const v of ["Vindemiatrix","Despina","Leda","Aoede","Sulafat","Autonoe"]) console.log(await run(v))
