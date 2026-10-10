ALTER TABLE "request_log" DROP CONSTRAINT "request_log_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "request_log" DROP CONSTRAINT "request_log_api_key_id_api_key_id_fk";
--> statement-breakpoint
ALTER TABLE "request_log" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "request_log" ALTER COLUMN "api_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE set null ON UPDATE no action;