export class SentenceSegmenter {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const sentences: string[] = [];
    const pattern = /([\s\S]*?[。！？!?]+[”’"']?|[\s\S]*?\.(?=\s|$))/g;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = pattern.exec(this.buffer))) {
      const sentence = match[0].trim();
      if (sentence) sentences.push(sentence);
      consumed = pattern.lastIndex;
    }
    this.buffer = this.buffer.slice(consumed);
    return sentences;
  }

  flush(): string | undefined {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining || undefined;
  }

  reset() {
    this.buffer = "";
  }
}
