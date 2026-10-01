import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-autocompact";
export declare const inject: string[];
export interface Config {
    mode?: 'observe' | 'correct';
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    mode: Schema<"observe" | "correct", "observe" | "correct", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    mode: Schema<"observe" | "correct", "observe" | "correct", "defined">;
}>>, "plain">;
export declare function overflowLikely(message: string): boolean;
export declare function captureWindow(message: string): number | undefined;
export declare function apply(ctx: Context, config?: Config): void;
