interface ComplexityMetrics {
  lineCount: number;
  importCount: number;
  exportCount: number;
  functionCount: number;
}

export function analyzeFile(content: string): ComplexityMetrics {
  const lines = content.split("\n");
  let importCount = 0;
  let exportCount = 0;
  let functionCount = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^import\s/.test(trimmed)) importCount++;
    if (/^export\s/.test(trimmed)) exportCount++;
    if (/function\s+\w+/.test(trimmed)) functionCount++;
    if (/(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/.test(trimmed)) functionCount++;
  }

  return {
    lineCount: lines.length,
    importCount,
    exportCount,
    functionCount,
  };
}

