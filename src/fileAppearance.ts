export function fileAppearance(filename: string, mime: string): { icon: string; label: string } {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const type = mime.toLowerCase();
  if (type === "application/pdf" || extension === "pdf") return { icon: "📕", label: "PDF" };
  if (/spreadsheet|excel|csv/.test(type) || /^(xlsx?|ods|csv|tsv)$/.test(extension)) return { icon: "📊", label: "表計算" };
  if (/presentation|powerpoint/.test(type) || /^(pptx?|odp|key)$/.test(extension)) return { icon: "📽️", label: "プレゼンテーション" };
  if (/word|opendocument.text/.test(type) || /^(docx?|odt|rtf|pages)$/.test(extension)) return { icon: "📝", label: "文書" };
  if (type.startsWith("audio/") || /^(mp3|wav|m4a|aac|ogg|flac)$/.test(extension)) return { icon: "🎵", label: "音声" };
  if (type.startsWith("video/") || /^(mp4|mov|webm|avi|mkv)$/.test(extension)) return { icon: "🎬", label: "動画" };
  if (/zip|compressed|archive|tar|gzip/.test(type) || /^(zip|7z|rar|tar|gz|bz2|xz)$/.test(extension)) return { icon: "📦", label: "圧縮ファイル" };
  if (type.startsWith("image/") || /^(svg|heic|heif|tiff?|bmp|ico)$/.test(extension)) return { icon: "🖼️", label: "画像ファイル" };
  if (/^(js|jsx|ts|tsx|py|json|html?|css|sh|sql|xml|ya?ml)$/.test(extension)) return { icon: "💻", label: "コード" };
  if (type.startsWith("text/") || /^(txt|md|log)$/.test(extension)) return { icon: "📄", label: "テキスト" };
  return { icon: "📎", label: "ファイル" };
}
