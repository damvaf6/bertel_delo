variable "env" {
  description = "Контур: stage (проверочный) или prod (боевой)"
  type        = string
  validation {
    condition     = contains(["stage", "prod"], var.env)
    error_message = "env: stage или prod."
  }
}

variable "cloud_id" { type = string }
variable "folder_id" { type = string }

variable "zone" {
  type    = string
  default = "ru-central1-a"
}

variable "name_suffix" {
  description = "Короткий суффикс для глобально уникальных имён бакетов"
  type        = string
}

variable "pg_preset" {
  description = "Класс хостов PostgreSQL (stage — экономичный, prod — стандартный)"
  type        = string
}

variable "pg_disk_gb" {
  type    = number
  default = 20
}

variable "pg_backup_days" {
  description = "Сколько дней хранить автоматические копии базы (восстановление на любой момент внутри срока)"
  type        = number
}

variable "files_noncurrent_days" {
  description = "Сколько дней можно вернуть удалённый/перезаписанный файл"
  type        = number
  default     = 30
}
