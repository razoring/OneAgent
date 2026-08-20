import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from '@xenova/transformers';
import AdmZip from 'adm-zip';
// @ts-ignore
import * as _pdfParse from 'pdf-parse/lib/pdf-parse.js';
// Ensure pdfParse is a function, regardless of how it was exported
const pdfParse: any = (typeof _pdfParse === 'function') ? _pdfParse : ((_pdfParse as any).default || _pdfParse);
import * as officeParser from 'officeparser';

export interface DocumentChunk {
  text: string;
  metadata: {
    source: string;
    page?: number;
    slide?: number;
    chunkIndex: number;
  };
}

let extractor: any = null;

// Initialize the embedding model (runs once)
export async function getExtractor() {
  if (!extractor) {
    // all-MiniLM-L6-v2 is a lightweight, high-quality embedding model (~40MB)
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractor;
}

// Generate embeddings for an array of strings
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const ext = await getExtractor();
  const output = await ext(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}

// Simple chunking for plain text (by word/token count approx)
export function chunkText(text: string, source: string, maxChars: number = 2000, overlap: number = 200): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let i = 0;
  let chunkIndex = 1;
  while (i < text.length) {
    const end = Math.min(i + maxChars, text.length);
    const chunkText = text.slice(i, end).trim();
    if (chunkText.length > 50) { // ignore very small chunks
      chunks.push({
        text: chunkText,
        metadata: { source, chunkIndex }
      });
    }
    if (end === text.length) break;
    i += maxChars - overlap;
    chunkIndex++;
  }
  return chunks;
}

// PDF Pagination using pdf-parse with a custom pagerender
export async function parsePdfToChunks(buffer: Buffer, source: string): Promise<DocumentChunk[]> {
  const options = {
    pagerender: function(pageData: any) {
      return pageData.getTextContent().then(function(textContent: any) {
        let lastY, text = '';
        for (let item of textContent.items) {
          if (lastY == item.transform[5] || !lastY) { text += item.str; }
          else { text += '\n' + item.str; }
          lastY = item.transform[5];
        }
        return '\n---PAGE_BOUNDARY---\n' + text;
      });
    }
  };
  
  const data = await pdfParse(buffer, options);
  const pages = data.text.split('\n---PAGE_BOUNDARY---\n');
  
  const chunks: DocumentChunk[] = [];
  let chunkIndex = 1;
  
  // pages[0] is usually empty because the boundary is added at the start of page 1
  pages.forEach((pageText: string, idx: number) => {
    if (pageText.trim().length > 10) {
      // If a single page is still huge, we chunk it further
      const subChunks = chunkText(pageText, source, 2000, 200);
      subChunks.forEach(sc => {
        chunks.push({
          text: sc.text,
          metadata: { source, page: idx, chunkIndex: chunkIndex++ }
        });
      });
    }
  });
  
  return chunks;
}

// PPTX Slide extraction using adm-zip
export async function parsePptxToChunks(buffer: Buffer, source: string): Promise<DocumentChunk[]> {
  try {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    
    // Find all slide xmls
    const slideEntries = zipEntries.filter(entry => 
      entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')
    );
    
    // Sort by slide number
    slideEntries.sort((a, b) => {
      const matchA = a.entryName.match(/slide(\d+)\.xml/);
      const matchB = b.entryName.match(/slide(\d+)\.xml/);
      const numA = matchA ? parseInt(matchA[1]) : 0;
      const numB = matchB ? parseInt(matchB[1]) : 0;
      return numA - numB;
    });

    const chunks: DocumentChunk[] = [];
    let chunkIndex = 1;
    
    slideEntries.forEach(entry => {
      const xml = entry.getData().toString('utf-8');
      // Extract text from <a:t> nodes
      const texts = xml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
      const slideText = texts.map(t => t.replace(/<a:t>/, '').replace(/<\/a:t>/, '')).join(' ').trim();
      
      const match = entry.entryName.match(/slide(\d+)\.xml/);
      const slideNum = match ? parseInt(match[1]) : 0;

      if (slideText.length > 5) {
        chunks.push({
          text: slideText,
          metadata: { source, slide: slideNum, chunkIndex: chunkIndex++ }
        });
      }
    });
    
    if (chunks.length > 0) return chunks;
  } catch (e) {
    console.error('[parsePptxToChunks] Custom extraction failed, falling back to officeparser', e);
  }
  
  // Fallback
  const parsed = await officeParser.parseOffice(buffer, { fileType: 'pptx', outputErrorToConsole: false });
  const text = typeof parsed.toText === 'function' ? parsed.toText() : String(parsed);
  return chunkText(text, source);
}

// Generic cosine similarity calculation
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Search chunks against a query embedding
export function searchChunks(queryEmbedding: number[], chunks: DocumentChunk[], chunkEmbeddings: number[][], topK: number = 5): DocumentChunk[] {
  const scores = chunks.map((chunk, i) => {
    return {
      chunk,
      score: cosineSimilarity(queryEmbedding, chunkEmbeddings[i])
    };
  });
  
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK).map(s => s.chunk);
}
