import Foundation
import SwiftUI

enum StudyTaskType: String, CaseIterable, Codable, Identifiable {
    case course
    case review
    case skill
    case practice
    case knowledge
    case homework

    var id: String { rawValue }

    var label: String {
        switch self {
        case .course: return "课程学习"
        case .review: return "复习巩固"
        case .skill: return "技能拓展"
        case .practice: return "实践"
        case .knowledge: return "知识库搭建"
        case .homework: return "做作业"
        }
    }

    var calendarTag: String {
        switch self {
        case .course: return "课程"
        case .review: return "复习"
        case .skill: return "技能"
        case .practice: return "实践"
        case .knowledge: return "知识库"
        case .homework: return "作业"
        }
    }

    var tint: Color {
        switch self {
        case .course: return .red
        case .review: return .orange
        case .skill: return .blue
        case .practice: return .green
        case .knowledge: return .purple
        case .homework: return .teal
        }
    }

    var xpMultiplier: Double {
        switch self {
        case .course, .knowledge: return 1.0
        case .review: return 0.9
        case .skill: return 1.1
        case .practice: return 1.05
        case .homework: return 0.95
        }
    }

    var wealthMultiplier: Double {
        switch self {
        case .course, .homework: return 1.0
        case .review: return 0.9
        case .skill: return 1.2
        case .practice, .knowledge: return 1.1
        }
    }
}

enum QuestStatus: String, Codable {
    case todo
    case done
}

struct PlayerState: Codable, Equatable {
    var level: Int = 1
    var xp: Int = 0
    var wealth: Int = 0
    var streak: Int = 0
    var lastCompletedDate: Date?
    var totalDone: Int = 0
    var totalMinutes: Int = 0

    enum CodingKeys: String, CodingKey {
        case level
        case xp
        case wealth
        case streak
        case lastCompletedDate = "last_completed_date"
        case totalDone = "total_done"
        case totalMinutes = "total_minutes"
    }
}

struct StudyQuest: Identifiable, Codable, Equatable {
    var id: Int
    var title: String
    var courseName: String
    var taskType: StudyTaskType
    var start: Date
    var end: Date
    var durationMinutes: Int
    var rewardXP: Int
    var rewardWealth: Int
    var status: QuestStatus
    var createdAt: Date
    var completedAt: Date?
    var calendarSyncStatus: String
    var calendarSyncMessage: String

    var displayTitle: String {
        courseName.isEmpty ? title : "\(courseName) · \(title)"
    }

    var calendarTitle: String {
        courseName.isEmpty ? title : "\(courseName) \(title)"
    }

    var isDone: Bool {
        status == .done || completedAt != nil
    }

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case courseName = "course_name"
        case taskType = "task_type"
        case start
        case end
        case durationMinutes = "duration_minutes"
        case rewardXP = "reward_xp"
        case rewardWealth = "reward_wealth"
        case status
        case createdAt = "created_at"
        case completedAt = "completed_at"
        case calendarSyncStatus = "calendar_sync_status"
        case calendarSyncMessage = "calendar_sync_message"
    }
}

struct StudyState: Codable, Equatable {
    var player = PlayerState()
    var nextID: Int = 1
    var quests: [StudyQuest] = []

    enum CodingKeys: String, CodingKey {
        case player
        case nextID = "next_id"
        case quests
    }
}

enum StudyDateFormatters {
    static let taskDateTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    static let taskDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static let displayTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static let displayDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日"
        return formatter
    }()
}
