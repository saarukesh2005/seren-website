-- Customer birthdays (month and day only, "MM-DD"), for birthday cake reminders the owner sends on WhatsApp.
ALTER TABLE customers ADD COLUMN birthday TEXT NOT NULL DEFAULT '';
