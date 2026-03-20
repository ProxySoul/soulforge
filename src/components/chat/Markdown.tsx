import { createContext, memo } from "react";
import { getSyntaxStyle, getTSClient } from "../../core/utils/syntax.js";

const CodeExpandedContext = createContext(false);
export const CodeExpandedProvider = CodeExpandedContext.Provider;

interface Props {
  text: string;
  streaming?: boolean;
}

const TABLE_OPTIONS = {
  widthMode: "content" as const,
  wrapMode: "word" as const,
  borders: true,
  borderStyle: "rounded" as const,
  borderColor: "#333",
  cellPadding: 0,
};

export const Markdown = memo(function Markdown({ text, streaming }: Props) {
  const syntaxStyle = getSyntaxStyle();
  const tsClient = getTSClient();

  return (
    <markdown
      content={text}
      syntaxStyle={syntaxStyle}
      treeSitterClient={tsClient}
      conceal
      streaming={streaming}
      tableOptions={TABLE_OPTIONS}
    />
  );
});
