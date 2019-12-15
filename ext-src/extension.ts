import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

import { extractGraphQLSources } from "./findGraphQLSources";
import { loadSchema } from "./loadSchema";
import {
  RawSchema,
  StartEditConfig,
  GraphQLSource,
  Command
} from "./extensionTypes";

export function extractSelectedOperation(
  textEditor: vscode.TextEditor
): GraphQLSource | null {
  const sources = extractGraphQLSources(textEditor.document);

  if (!sources || sources.length < 1) {
    vscode.window.showErrorMessage("No GraphQL sources found in file.");
    return null;
  }

  let targetSource: GraphQLSource | null = null;

  if (sources[0].type === "FULL_DOCUMENT") {
    targetSource = sources[0];
  } else {
    // A tag must be focused
    const selection = textEditor.selection.active;

    for (let i = 0; i <= sources.length - 1; i += 1) {
      const t = sources[i];

      if (t.type === "TAG" && selection.line >= t.start.line) {
        targetSource = t;
      }
    }
  }

  return targetSource;
}

export function activate(context: vscode.ExtensionContext) {
  const loadSchemaAndLaunch = async (
    config: Command,
    textEditor: vscode.TextEditor
  ) => {
    try {
      if (!vscode.workspace.rootPath) {
        throw new Error("Missing rootPath");
      }

      const schema = await loadSchema(vscode.workspace.rootPath);

      if (!schema) {
        vscode.window.showErrorMessage(
          "Could not load schema. Please make sure you have your schema configured properly."
        );
        return;
      }

      GraphiQLExplorerPanel.createOrShow(
        context.extensionPath,
        config,
        schema,
        textEditor.document
      );
    } catch (e) {
      vscode.window.showErrorMessage(
        "Something went wrong loading the schema: " + e.message
      );
      vscode.window.showErrorMessage(e.stack);
      return;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-graphiql-explorer.edit", () => {
      const textEditor = vscode.window.activeTextEditor;

      if (!textEditor) {
        vscode.window.showErrorMessage("Missing active text editor.");
        return;
      }

      const selectedOperation = extractSelectedOperation(textEditor);

      if (selectedOperation) {
        if (
          selectedOperation.type === "TAG" &&
          /^[\s]+$/g.test(selectedOperation.content)
        ) {
          vscode.window.showInformationMessage(
            "Please use the Insert command if you want to edit an empty operation."
          );
          return;
        }

        loadSchemaAndLaunch(
          {
            type: "startEditing",
            source: selectedOperation
          },
          textEditor
        );
      }
    }),
    vscode.commands.registerCommand("vscode-graphiql-explorer.show", () => {
      const textEditor = vscode.window.activeTextEditor;

      if (!textEditor) {
        vscode.window.showErrorMessage("Missing active text editor.");
        return;
      }

      const selectedOperation = extractSelectedOperation(textEditor);

      if (selectedOperation && selectedOperation.type === "TAG") {
        vscode.window.showInformationMessage(
          "Please put your cursor outside of GraphQL definitions when you only want to explore your schema."
        );
        return;
      }

      loadSchemaAndLaunch({ type: "show" }, textEditor);
    }),
    vscode.commands.registerCommand("vscode-graphiql-explorer.insert", () => {
      const textEditor = vscode.window.activeTextEditor;

      if (!textEditor) {
        vscode.window.showErrorMessage("Missing active text editor.");
        return;
      }

      const selectedOperation = extractSelectedOperation(textEditor);

      if (
        selectedOperation &&
        selectedOperation.type === "TAG" &&
        !/^[\s]+$/g.test(selectedOperation.content)
      ) {
        vscode.window.showInformationMessage(
          "Please select an empty GraphQL tag when you want to insert a new operation."
        );
        return;
      }

      const selection = textEditor.selection.active;

      loadSchemaAndLaunch(
        {
          type: "insert",
          position: {
            line: selection.line,
            character: selection.character
          }
        },
        textEditor
      );
    })
  );
}

class GraphiQLExplorerPanel {
  public static currentPanel: GraphiQLExplorerPanel | undefined;

  private static readonly viewType = "graphqiql-explorer";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionPath: string;
  private _disposables: vscode.Disposable[] = [];
  private _currentTextDocument: vscode.TextDocument | null = null;

  public static createOrShow(
    extensionPath: string,
    config: Command,
    schema: RawSchema,
    document: vscode.TextDocument
  ) {
    const column = vscode.ViewColumn.Active;

    if (GraphiQLExplorerPanel.currentPanel) {
      GraphiQLExplorerPanel.currentPanel._panel.reveal(column);
    } else {
      GraphiQLExplorerPanel.currentPanel = new GraphiQLExplorerPanel(
        extensionPath,
        column
      );
    }

    GraphiQLExplorerPanel.currentPanel.sendCommand(config, document, schema);
  }

  private constructor(extensionPath: string, column: vscode.ViewColumn) {
    this._extensionPath = extensionPath;

    this._panel = vscode.window.createWebviewPanel(
      GraphiQLExplorerPanel.viewType,
      "GraphiQL Explorer",
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this._extensionPath, "build"))
        ]
      }
    );

    this._panel.webview.html = this._getHtmlForWebview();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      message => {
        let dispose = () => {
          this._currentTextDocument = null;
          this.dispose();
        };

        switch (message.command) {
          case "insert": {
            let position: { line: number; character: number } =
              message.position;
            let content: string = message.content;

            let textDocument = this._currentTextDocument;

            if (textDocument) {
              vscode.window
                .showTextDocument(textDocument)
                .then((textEditor: vscode.TextEditor) => {
                  textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
                    editBuilder.insert(
                      new vscode.Position(position.line, position.character),
                      content
                    );
                    dispose();
                  });
                });
            }
            break;
          }
          case "cancel":
            dispose();
            break;
          case "save": {
            let targetSource: GraphQLSource = message.targetSource;
            let newContent: string = message.newContent;

            let textDocument = this._currentTextDocument;

            if (textDocument) {
              vscode.window
                .showTextDocument(textDocument)
                .then((textEditor: vscode.TextEditor) => {
                  textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
                    if (targetSource.type === "TAG") {
                      editBuilder.replace(
                        new vscode.Range(
                          new vscode.Position(
                            targetSource.start.line,
                            targetSource.start.character
                          ),
                          new vscode.Position(
                            targetSource.end.line,
                            targetSource.end.character
                          )
                        ),
                        newContent
                      );
                    } else if (
                      targetSource.type === "FULL_DOCUMENT" &&
                      textDocument
                    ) {
                      editBuilder.replace(
                        new vscode.Range(
                          new vscode.Position(0, 0),
                          new vscode.Position(textDocument.lineCount + 1, 0)
                        ),
                        newContent
                      );
                    }

                    dispose();
                  });
                });
            } else {
              vscode.window.showErrorMessage("Missing target TextDocument.");
              return;
            }
          }
        }
      },
      null,
      this._disposables
    );
  }

  public sendCommand(
    config: Command,
    document: vscode.TextDocument,
    schema: RawSchema
  ) {
    this._currentTextDocument = document;

    this._panel.webview.postMessage({
      command: config.type,
      data: { config, schema }
    });
  }

  public dispose() {
    GraphiQLExplorerPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview() {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(this._extensionPath, "build", "asset-manifest.json"),
        "utf8"
      )
    );

    const mainScript = manifest["main.js"];
    const mainStyle = manifest["main.css"];

    const scriptPathOnDisk = vscode.Uri.file(
      path.join(this._extensionPath, "build", mainScript)
    );
    const scriptUri = scriptPathOnDisk.with({ scheme: "vscode-resource" });
    const stylePathOnDisk = vscode.Uri.file(
      path.join(this._extensionPath, "build", mainStyle)
    );
    const styleUri = stylePathOnDisk.with({ scheme: "vscode-resource" });

    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
				<meta name="theme-color" content="#000000">
				<title>GraphiQL Explorer</title>
				<link rel="stylesheet" type="text/css" href="${styleUri}">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;">
				<base href="${vscode.Uri.file(path.join(this._extensionPath, "build")).with({
          scheme: "vscode-resource"
        })}/">
			</head>
			
			<body>
				<noscript>You need to enable JavaScript to run this app.</noscript>
				<div id="root"></div>
				
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
  }
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
