/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import * as fetch from "./fetchAPI";
import * as userLogin from "./userLogin";
import * as storeVersions from './storeVersions';
import * as interactiveDiff from "./interactiveDiff";
import * as estate from './estate';
const Diff = require('diff');  // Documentation: https://github.com/kpdecker/jsdiff/


export async function cleanupEditChaining(editor: vscode.TextEditor)
{
    let state = estate.state_of_editor(editor);
    if (state) {
        state.edit_chain_modif_doc = undefined;
    }
}


export async function runEditChaining(animation: boolean): Promise<String>
{
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return "";
    }
    let state = estate.state_of_editor(editor);
    if (!state) {
        return "";
    }
    if (state.get_mode() !== estate.Mode.Normal && state.get_mode() !== estate.Mode.Highlight && state.get_mode() !== estate.Mode.DiffWait) {
        return "";
    }
    let doc = editor.document;
    let position: vscode.Position = editor.selection.active;
    let cursor = doc.offsetAt(position);
    let file_name = storeVersions.filename_from_document(doc);

    let cancellationTokenSource = new vscode.CancellationTokenSource();
    let cancelToken = cancellationTokenSource.token;
    let request = new fetch.PendingRequest(undefined, cancelToken);

    await fetch.cancelAllRequests();
    // if (state.mode === interactiveDiff.Mode.DiffWait) {
    //     state.mode = interactiveDiff.Mode.Normal;
    // }
    request.cancellationTokenSource = cancellationTokenSource;
    let login: any = await userLogin.login();
    if (!login) { return ""; }
    await fetch.waitAllRequests();
    if (cancelToken.isCancellationRequested) {
        return "";
    }

    let whole_doc = doc.getText();
    let max_tokens = 200;
    let max_edits = 3;
    // let current_line = document.lineAt(position.line);
    // let left_of_cursor = current_line.text.substring(0, position.character);
    // let right_of_cursor = current_line.text.substring(position.character);
    let more_revisions: { [key: string]: string } = storeVersions.fnGetRevisions(file_name);
    let send_revisions: { [key: string]: string } = {};
    // let recent_but_different = "";
    let first_time_a_lot_of_changes = "";
    for (let key in more_revisions) {
        let rev = more_revisions[key];
        if (whole_doc === rev) {
            console.log(["EC same text", key]);
            continue;
        }
        const diff = Diff.diffLines(whole_doc, rev);
        let count_added = 0;
        let count_removed = 0;
        diff.forEach((part: any) => {
            if (part.added) {
                count_added += 1;
            } else if (part.removed) {
                count_removed += 1;
            }
        });
        // recent_but_different = key;
        // send_revisions[key] = rev
        console.log(["EC echain", key]);
        console.log(["EC added", count_added, "removed", count_removed]);
        first_time_a_lot_of_changes = key;
        if (count_added + count_removed > 2) {
            console.log(["EC HAPPY"]);
            break;
        }
    }
    if (!first_time_a_lot_of_changes) {
        return "";
    }
    send_revisions[first_time_a_lot_of_changes] = more_revisions[first_time_a_lot_of_changes];
    send_revisions[file_name] = whole_doc;
    let stop_tokens: string[] = [];
    let line_n = position.line;
    let sensitive_area = new vscode.Range(new vscode.Position(line_n, 0), new vscode.Position(line_n, 0));
    if (animation) {
        interactiveDiff.animationStart(editor, sensitive_area);
    }
    request.supply_stream(...fetch.fetch_api_promise(
        cancelToken,
        "runEditChaining",
        send_revisions,
        estate.global_intent,
        "edit-chain",
        file_name,
        cursor,
        cursor,
        max_tokens,
        max_edits,
        stop_tokens,
    ));
    // if ((state.mode === estate.Mode.DiffWait) && !cancelToken.isCancellationRequested) {
    //     state.mode = estate.Mode.Normal;
    // }
    let json: any;
    try {
        json = await request.apiPromise;
    } finally {
        if (fetch.look_for_common_errors(json, request.api_fields)) {
            return "";
        }
    }
    state.showing_diff_edit_chain = sensitive_area;
    state.edit_chain_modif_doc = json["choices"][0]["files"][file_name];
    if (state.edit_chain_modif_doc) {
        let summary = generateDiffSummary(line_n, whole_doc, state.edit_chain_modif_doc);
        console.log(["CHAIN summary", summary]);
        return summary;
    } else {
        return "";
    }
}


function generateDiffSummary(current_line: number, whole_doc: string, modif_doc: string): string
{
    if (whole_doc === modif_doc) {
        console.log(["modified document is identical"]);
        return "";
    }
    const diff = Diff.diffLines(whole_doc, modif_doc);
    let count_added = 0;
    let count_removed = 0;
    let first_line = -1;
    let first_chars = "";
    let prefer_added = true;
    let line_n = 0;
    diff.forEach((part: any) => {
        let span = part.value;
        if (part.added) {
            count_added += span.split("\n").length - 1;
            if (first_line === -1 || prefer_added) {
                prefer_added = false;
                if (first_line === -1) {
                    first_line = line_n;
                }
                first_chars = span;
            }
        } else if (part.removed) {
            count_removed += span.split("\n").length - 1;
            if (first_line === -1) {
                first_line = line_n;
                first_chars = span;
            }
            line_n += span.split("\n").length - 1;
        } else {
            line_n += span.split("\n").length - 1;
        }
    });
    let tmp = first_chars.trim();
    let slash_n = tmp.indexOf("\n");
    if (slash_n !== -1) {
        tmp = tmp.substring(0, slash_n);
    }
    first_chars = tmp.substring(0, 50);
    if (tmp.length > 50) {
        first_chars += "…";
    }
    let result = "";
    if (first_line <= current_line) {
        result = " ⬆️ line " + (first_line + 1).toString() + " ⬆️   ";
    } else {
        result = " ⬇️ line " + (first_line + 1).toString() + " ⬇️   ";
    }
    for (let c=0; c<count_removed; c++) {
        result += "-";
    }
    for (let c=0; c<count_added; c++) {
        result += "+";
    }
    result += "   " + first_chars;
    return result;
}


// export async function acceptEditChain(document: vscode.TextDocument, pos: vscode.Position)
// {
//     // FIXME: this function might be a bad idea
//     let state2 = estate.state_of_document(document);
//     if (!state2) {
//         console.log(["EC Ref Accepted but no state"]);
//         return;
//     }
//     console.log(["EC Ref Accepted", pos.line, pos.character]);
//     let editor = state2.editor;
//     let next_line_pos = new vscode.Position(pos.line + 1, 0);
//     let next_next_line_pos = new vscode.Position(pos.line + 2, 0);
//     await editor.edit((e) => {
//         console.log(["EC Ref Accepted deleting..."]);
//         e.delete(new vscode.Range(next_line_pos, next_next_line_pos));
//     }, { undoStopBefore: false, undoStopAfter: false }).then(() => {
//         console.log(["EC Ref Accepted done"]);
//         if (!editor || !state2) {
//             return;
//         }
//         let modif_doc = state2.edit_chain_modif_doc;
//         if (modif_doc) {
//             state2.showing_diff_modif_doc = modif_doc;
//             state2.showing_diff_move_cursor = true;
//             state2.showing_diff_for_function = "edit-chain";
//             state2.showing_diff_for_range = undefined;
//             estate.switch_mode(state2, estate.Mode.Diff);
//         }
//     });
// }
