import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import TrackerEntry from '@/lib/models/TrackerEntry';
import mongoose from 'mongoose';

// GET /api/tracker/[id] - Get a single tracker entry
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    
    const { id } = params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { error: 'Invalid tracker entry ID' },
        { status: 400 }
      );
    }
    
    const entry = await TrackerEntry.findById(id).populate('eventId');
    
    if (!entry) {
      return NextResponse.json(
        { error: 'Tracker entry not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json(entry);
  } catch (error) {
    console.error('Error fetching tracker entry:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tracker entry' },
      { status: 500 }
    );
  }
}

// PUT /api/tracker/[id] - Update a tracker entry
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    
    const { id } = params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { error: 'Invalid tracker entry ID' },
        { status: 400 }
      );
    }
    
    const body = await request.json();
    
    // Don't allow updating eventId
    delete body.eventId;
    
    const entry = await TrackerEntry.findByIdAndUpdate(
      id,
      { $set: body },
      { new: true, runValidators: true }
    ).populate('eventId');
    
    if (!entry) {
      return NextResponse.json(
        { error: 'Tracker entry not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json(entry);
  } catch (error: any) {
    console.error('Error updating tracker entry:', error);
    return NextResponse.json(
      { error: 'Failed to update tracker entry', details: error.message },
      { status: 500 }
    );
  }
}

// DELETE /api/tracker/[id] - Delete a tracker entry
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    
    const { id } = params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { error: 'Invalid tracker entry ID' },
        { status: 400 }
      );
    }
    
    const entry = await TrackerEntry.findByIdAndDelete(id);
    
    if (!entry) {
      return NextResponse.json(
        { error: 'Tracker entry not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({ message: 'Tracker entry deleted successfully' });
  } catch (error) {
    console.error('Error deleting tracker entry:', error);
    return NextResponse.json(
      { error: 'Failed to delete tracker entry' },
      { status: 500 }
    );
  }
}

// Made with Bob