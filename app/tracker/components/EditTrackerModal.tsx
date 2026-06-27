'use client';

import { useState } from 'react';

interface Connection {
  name: string;
  role?: string;
  company?: string;
  linkedin?: string;
  context?: string;
  followUpAt?: string;
}

interface EditTrackerModalProps {
  entryId: string;
  currentNotes?: string;
  currentConnections: Connection[];
  onClose: () => void;
  onSave: () => void;
}

export default function EditTrackerModal({
  entryId,
  currentNotes = '',
  currentConnections,
  onClose,
  onSave,
}: EditTrackerModalProps) {
  const [notes, setNotes] = useState(currentNotes);
  const [connections, setConnections] = useState<Connection[]>(currentConnections);
  const [showAddConnection, setShowAddConnection] = useState(false);
  const [newConnection, setNewConnection] = useState<Connection>({
    name: '',
    role: '',
    company: '',
    linkedin: '',
    context: '',
    followUpAt: '',
  });
  const [saving, setSaving] = useState(false);

  const addConnection = () => {
    if (newConnection.name.trim()) {
      setConnections([...connections, newConnection]);
      setNewConnection({
        name: '',
        role: '',
        company: '',
        linkedin: '',
        context: '',
        followUpAt: '',
      });
      setShowAddConnection(false);
    }
  };

  const removeConnection = (index: number) => {
    setConnections(connections.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const response = await fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          connections,
        }),
      });

      if (!response.ok) throw new Error('Failed to save');

      onSave();
      onClose();
    } catch (err) {
      alert('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-start mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Edit Tracker Entry</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>

          {/* Notes Section */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              placeholder="Add notes about your application, deadlines, or anything else..."
            />
          </div>

          {/* Connections Section */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-3">
              <label className="block text-sm font-medium text-gray-700">
                Networking Connections
              </label>
              <button
                onClick={() => setShowAddConnection(true)}
                className="text-sm text-purple-600 hover:text-purple-700 font-medium"
              >
                + Add Connection
              </button>
            </div>

            {/* Existing Connections */}
            <div className="space-y-3 mb-4">
              {connections.map((conn, idx) => (
                <div key={idx} className="p-4 bg-gray-50 rounded-lg relative">
                  <button
                    onClick={() => removeConnection(idx)}
                    className="absolute top-2 right-2 text-gray-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                  <div className="font-medium text-gray-900">{conn.name}</div>
                  {conn.role && (
                    <div className="text-sm text-gray-600">{conn.role}</div>
                  )}
                  {conn.company && (
                    <div className="text-sm text-gray-600">{conn.company}</div>
                  )}
                  {conn.context && (
                    <div className="text-sm text-gray-500 mt-1">{conn.context}</div>
                  )}
                  {conn.linkedin && (
                    <a
                      href={conn.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-purple-600 hover:underline mt-1 inline-block"
                    >
                      LinkedIn →
                    </a>
                  )}
                  {conn.followUpAt && (
                    <div className="text-xs text-gray-500 mt-2">
                      Follow up: {new Date(conn.followUpAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Add Connection Form */}
            {showAddConnection && (
              <div className="p-4 border-2 border-purple-200 rounded-lg bg-purple-50">
                <h4 className="font-medium text-gray-900 mb-3">Add New Connection</h4>
                <div className="space-y-3">
                  <input
                    type="text"
                    value={newConnection.name}
                    onChange={(e) =>
                      setNewConnection({ ...newConnection, name: e.target.value })
                    }
                    placeholder="Name *"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <input
                    type="text"
                    value={newConnection.role}
                    onChange={(e) =>
                      setNewConnection({ ...newConnection, role: e.target.value })
                    }
                    placeholder="Role (e.g., Senior Engineer)"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <input
                    type="text"
                    value={newConnection.company}
                    onChange={(e) =>
                      setNewConnection({ ...newConnection, company: e.target.value })
                    }
                    placeholder="Company"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <input
                    type="url"
                    value={newConnection.linkedin}
                    onChange={(e) =>
                      setNewConnection({ ...newConnection, linkedin: e.target.value })
                    }
                    placeholder="LinkedIn URL"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <textarea
                    value={newConnection.context}
                    onChange={(e) =>
                      setNewConnection({ ...newConnection, context: e.target.value })
                    }
                    placeholder="Context (what you discussed, how you met, etc.)"
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <input
                    type="date"
                    value={newConnection.followUpAt}
                    onChange={(e) =>
                      setNewConnection({ ...newConnection, followUpAt: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={addConnection}
                      className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                    >
                      Add Connection
                    </button>
                    <button
                      onClick={() => setShowAddConnection(false)}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Made with Bob