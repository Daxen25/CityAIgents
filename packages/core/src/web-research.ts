import {z} from 'zod';
const text=(max:number)=>z.string().trim().min(1).max(max).refine(s=>s.isWellFormed()&&!s.includes('\0'));
// These URLs are displayed only. No application code fetches evidence URLs.
export function publicEvidenceUrl(value:string):boolean {
 try {
  const u=new URL(value),h=u.hostname.toLowerCase();
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&value.length<=2000&&
   /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h)&&h.includes('.')&&
   !h.split('.').some(p=>!p||p.startsWith('-')||p.endsWith('-'))&&
   !/^[0-9.]+$/.test(h)&&!/(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(h)&&
   !h.endsWith('.arpa')&&!h.startsWith('metadata.')&&!/[\u0000-\u0020\\]/.test(value);
 }catch{return false;}
}
export const evidenceSourceSchema=z.strictObject({id:z.string().regex(/^S[1-5]$/),title:text(300),url:text(2000).refine(publicEvidenceUrl),excerpt:text(2000),retrieved_at:z.iso.datetime(),provider:z.literal('tavily')});
export const webSynthesisSchema=z.strictObject({
 objective:text(2000),summary:text(2000),
 findings:z.array(z.strictObject({claim:text(1000),basis:z.enum(['source_excerpt','model_inference']),source_ids:z.array(z.string().regex(/^S[1-5]$/)).max(5)})).min(1).max(8),
 unverified_assertions:z.array(text(500)).max(8),conflicting_or_incomplete_information:z.array(text(500)).max(8),open_questions:z.array(text(500)).max(8),recommendations:z.array(text(500)).max(8),limitations:z.array(text(500)).min(1).max(8),
});
export const webResearchDocumentSchema=webSynthesisSchema.extend({sources:z.array(evidenceSourceSchema).min(1).max(5),verification:z.literal('provider_excerpts_not_independently_verified')}).superRefine((v,c)=>{
 if(new TextEncoder().encode(JSON.stringify(v)).byteLength>44000)c.addIssue({code:"custom",message:"Report exceeds persistence budget"});
 const ids=new Set(v.sources.map(s=>s.id));
 if(ids.size!==v.sources.length||new Set(v.sources.map(s=>s.url)).size!==v.sources.length)c.addIssue({code:'custom',message:'Duplicate evidence'});
 for(const f of v.findings)if(f.source_ids.some(id=>!ids.has(id))||new Set(f.source_ids).size!==f.source_ids.length||(f.basis==='source_excerpt')!==(f.source_ids.length>0))c.addIssue({code:'custom',message:'Invalid evidence references'});
});
export type WebResearchDocument=z.infer<typeof webResearchDocumentSchema>;
export type EvidenceSource=z.infer<typeof evidenceSourceSchema>;
export const webDiagnosticsSchema=z.strictObject({search_requests:z.number().int().min(0).max(1),provider_requests:z.number().int().min(0).max(1),sources_discovered:z.number().int().min(0).max(5),stage:z.enum(['search','synthesis','complete']),http_status:z.number().int().min(100).max(599).nullable()});
export type WebDiagnostics=z.infer<typeof webDiagnosticsSchema>;
