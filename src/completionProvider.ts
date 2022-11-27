/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import * as fetch from "./fetchAPI";
import * as userLogin from "./userLogin";
import * as estate from "./estate";
import * as storeVersions from "./storeVersions";


class CacheEntry {
    public completion;
    public created_ts;
    public constructor(completion: string, created_ts: number) {
        this.completion = completion;
        this.created_ts = created_ts;
    }
};

const CACHE_STORE = 30;
const CACHE_AHEAD = 10;


export class MyInlineCompletionProvider implements vscode.InlineCompletionItemProvider
{
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        cancelToken: vscode.CancellationToken
    )
    {
        let state = estate.state_of_document(document);
        if (state) {
            if (state.get_mode() !== estate.Mode.Normal && state.get_mode() !== estate.Mode.Highlight) {
                console.log(["333 not inline", state.get_mode()]);
                return [];
            }
        }
        if (!estate.is_lang_enabled(document)) {
            return [];
        }
        let file_name = storeVersions.filename_from_document(document);
        let current_line = document.lineAt(position.line);
        let left_of_cursor = current_line.text.substring(0, position.character);
        let right_of_cursor = current_line.text.substring(position.character);
        let right_of_cursor_has_only_special_chars = Boolean(right_of_cursor.match(/^[:\s\t\n\r),."'\]]*$/));
        if (!right_of_cursor_has_only_special_chars) {
            return [];
        }
        let left_all_spaces = left_of_cursor.replace(/\s/g, "").length === 0;
        let cursor = document.offsetAt(position);
        let whole_doc = document.getText();
        if (whole_doc.length > 0 && whole_doc[whole_doc.length - 1] !== "\n") {
            whole_doc += "\n";
        }
        let text_left = whole_doc.substring(0, cursor);
        let deleted_spaces_left = 0;
        while (left_all_spaces && text_left.length > 0 && (text_left[text_left.length - 1] === " " || text_left[text_left.length - 1] === "\t")) {
            text_left = text_left.substring(0, text_left.length - 1);
            cursor -= 1;
            deleted_spaces_left += 1;
        }
        let eol_pos = new vscode.Position(position.line, current_line.text.length);
        whole_doc = text_left + whole_doc.substring(cursor);

        let delay_if_not_cached = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;

        console.log(["INFILL", left_of_cursor, "|", right_of_cursor]);

        let completion = await this.cached_request(
            cancelToken,
            delay_if_not_cached,
            file_name,
            whole_doc,
            cursor,
            left_all_spaces
        );

        // Undocumented brittle functionality, it's hard to describe what InlineCompletionItem exactly does, trial and error...
        let completionItem = new vscode.InlineCompletionItem(
            completion,
            // new vscode.Range(position, position.translate(0, completion_length))
            new vscode.Range(position.translate(0, -deleted_spaces_left), eol_pos),
            // new vscode.Range(position, eol_pos.translate(0, 1))
               //.translate(0, completion_length))
        );
        return [completionItem];
    }

    public cache: Map<string, CacheEntry> = new Map();  // LRUCache?

    public cleanup_cache()
    {
        while (1) {
            if (this.cache.size < CACHE_STORE) {
                return;
            }
            let oldest_key = null;
            let oldest_ts = null;
            for (let [key, value] of this.cache) {
                if (oldest_ts === null || value.created_ts < oldest_ts) {
                    oldest_ts = value.created_ts;
                    oldest_key = key;
                }
            }
            if (oldest_key === null) {
                return;
            }
            this.cache.delete(oldest_key);
        }
    }

    async cached_request(
        cancelToken: vscode.CancellationToken,
        delay_if_not_cached: boolean,
        file_name: string,
        whole_doc: string,
        cursor: number,
        multiline: boolean,
    ): Promise<string>
    {
        let left = whole_doc.substring(0, cursor);
        let cached = this.cache.get(left);
        if (cached !== undefined) {
            return cached.completion;
        }
        if (delay_if_not_cached) {
            let sleep = 30;  // In a hope this request will be cancelled
            await new Promise(resolve => setTimeout(resolve, sleep));
        }
        let login: any = await userLogin.login();
        if (!login) { return ""; }
        await fetch.waitAllRequests();
        if (cancelToken.isCancellationRequested) {
            console.log(["444 inline cancelled"]);
            return "";
        }
        let request = new fetch.PendingRequest(undefined, cancelToken);
        let max_tokens = 50;
        let max_edits = 1;
        let sources: { [key: string]: string } = {};
        sources[file_name] = whole_doc;
        let stop_tokens: string[];
        if (multiline) {
            stop_tokens = ["\n\n"];
        } else {
            stop_tokens = ["\n", "\n\n"];
        }
        let fail = false;
        let stop_at = cursor;
        let modif_doc = whole_doc;
        if (!fail) {
            let t0 = Date.now();
            request.supply_stream(...fetch.fetch_api_promise(
                cancelToken,
                "CompletionProvider", // scope
                sources,
                "Infill", // intent
                "infill", // scratchpad function
                file_name,
                cursor,
                cursor,
                max_tokens,
                max_edits,
                stop_tokens,
            ));
            let json: any;
            try {
                json = await request.apiPromise;
            } finally {
                if (fetch.look_for_common_errors(json, request.api_fields)) {
                    // Network failure: return empty string, but don't cache it
                    return "";
                }
            }
            let t1 = Date.now();
            let ms_int = Math.round(t1 - t0);
            console.log([`API request ${ms_int}ms`]);
            modif_doc = json["choices"][0]["files"][file_name];
            let before_cursor1 = whole_doc.substring(0, cursor);
            let before_cursor2 = modif_doc.substring(0, cursor);
            if (before_cursor1 !== before_cursor2) {
                console.log("before_cursor1 != before_cursor2");
                return "";
            }
            stop_at = 0;
            let any_different = false;
            for (let i = -1; i > -whole_doc.length; i--) {
                let char1 = whole_doc.slice(i, i + 1);
                let char2 = modif_doc.slice(i, i + 1);
                // console.log("i", i, "char1", char1, "char2", char2);
                if (char1 === "\n") {
                    stop_at = i + 1;
                }
                if (char1 !== char2) {
                    //stop_at = i + 1;
                    any_different = true;
                    break;
                }
            }
            fail = !any_different;
        }
        let completion = "";
        if (!fail) {
            fail = cursor >= modif_doc.length + stop_at;
            console.log([`FAIL cursor ${cursor} < ${modif_doc.length} + ${stop_at}`]);
        }
        if (!fail) {
            completion = modif_doc.substring(cursor, modif_doc.length + stop_at);
            console.log(["SUCCESS", request.seq, completion]);
        }
        if (!fail && !multiline) {
            completion = completion.replace(/\s+$/, "");
            console.log(["RTRIM", request.seq, completion]);
            fail = completion.match(/\n/g) !== null;
        } else if (!fail && multiline) {
            completion = completion.replace(/[ \t\n]+$/, "");
            console.log(["MLINE RTRIM", request.seq, completion]);
        }
        if (!fail) {
            fail = completion.length === 0;
        }
        for (let i = 0; i < Math.min(completion.length, CACHE_AHEAD); i++) {
            let more_left = left + completion.substring(0, i);
            this.cache.set(more_left, {
                completion: completion.substring(i),
                created_ts: Date.now(),
            });
        }
        this.cleanup_cache();
        return completion;
    }
}
